import { searchMail, inboxConfigured } from "./imap.js";
import { ATTENDING_RE } from "./links.js";
import type { Todo } from "../../src/data/types";
import { getCollection, setCollection, addAudit, redis } from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Check before asking. Some to-dos (RSVP to a party, sign up for a slot) are
// often ALREADY done by the time Kimi files them — one parent replied from their
// phone, the other parent's inbox holds the confirmation. Before a to-do like
// that is shown as open, look for proof it's done: the invite page itself
// ("You are attending") or a confirmation email in either parent's Gmail.
// ─────────────────────────────────────────────────────────────────────────────

const VERIFIABLE: { kind: "rsvp" | "signup"; title: RegExp; confirm: RegExp; query: (key: string) => string }[] = [
  {
    kind: "rsvp",
    title: /^\s*rsvp\b/i,
    confirm: /you('| a)re (confirmed|attending|going)|rsvp (confirmed|received|sent|recorded)|thanks for (your )?rsvp|you replied|your rsvp|response (sent|recorded)|you('| ha)ve rsvp'?d/i,
    // (A Google Calendar "Accepted:" notice is not an RSVP to the host — not counted.)
    query: (key) => `("${key}") (rsvp OR confirmed OR attending OR "you're going" OR "your response") -subject:accepted`,
  },
  {
    kind: "signup",
    title: /^\s*sign( |-)?up\b/i,
    confirm: /sign ?up confirmation|you('| ha)ve signed up|you('| a)re signed up|thanks for signing up|confirmed:? .*slot/i,
    query: (key) => `("${key}") ("sign up" OR signup OR signed OR confirmation)`,
  },
];

/** The distinctive words of a to-do ("RSVP to Maya's birthday party" → "Maya"). */
function subjectKey(title: string): string | null {
  const m = title.match(/\b(?:to|for)\s+(.+?)(?:['’]s\b|\s+\(|$)/i);
  const phrase = (m ? m[1] : title).replace(/[()]/g, " ").trim();
  const names = phrase.match(/\b[A-Z][a-zA-Z-]+/g)?.filter((w) => !/^(RSVP|Sign|The|A|An|Our|Birthday|Party)$/.test(w));
  return names?.length ? names[0] : null;
}

export interface Evidence {
  where: string; // "Sam's email: “You are confirmed for Maya's 6th Birthday Party” (Sep 16)"
}

/** Proof that a verifiable to-do is already done, or null. `pageText` = the invite page, if Kimi read it. */
export async function findCompletion(todo: Pick<Todo, "title">, pageText = ""): Promise<Evidence | null> {
  const rule = VERIFIABLE.find((r) => r.title.test(todo.title));
  if (!rule) return null;
  if (rule.kind === "rsvp" && pageText && ATTENDING_RE.test(pageText)) return { where: "the invitation page says you're attending" };
  const key = subjectKey(todo.title);
  if (!key) return null;
  for (const who of ["sam", "alex"] as const) {
    if (!inboxConfigured(who)) continue;
    try {
      const hits = await searchMail({ account: who, days: 150, query: rule.query(key), limit: 15 });
      const hit = hits.find((h) => h.subject.includes(key) && rule.confirm.test(`${h.subject} ${h.snippet}`));
      if (hit) {
        const date = new Date(hit.date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
        return { where: `${who === "sam" ? "Sam" : "Alex"}'s email: “${hit.subject.slice(0, 90)}” (${date})` };
      }
    } catch (e) {
      console.error("verify search failed", who, String(e).slice(0, 120));
    }
  }
  return null;
}

/** Mark to-dos done at creation when proof exists. Mutates in place; returns how many were closed. */
export async function closeIfAlreadyDone(todos: Todo[], pageText = ""): Promise<number> {
  let n = 0;
  for (const t of todos) {
    if (t.done || !VERIFIABLE.some((r) => r.title.test(t.title))) continue;
    const ev = await findCompletion(t, pageText);
    if (ev) {
      t.done = true;
      t.detail = `Already done — ${ev.where}.${t.detail ? " " + t.detail : ""}`;
      n++;
    }
  }
  return n;
}

/**
 * Re-check open RSVP / sign-up to-dos against both inboxes (a confirmation often
 * arrives after the invitation was filed, or the other parent replied). Runs at
 * most hourly from the cron; closes what's provably done and logs why.
 */
export async function sweepVerifiable(force = false, lastRun?: number): Promise<number> {
  if (!force) {
    // The cron passes the last-run time from its batched read; otherwise look it up.
    const last = lastRun ?? Number((await redis.get<number>("verify_sweep_last")) || 0);
    if (Date.now() - last < 60 * 60 * 1000) return 0;
  }
  await redis.set("verify_sweep_last", Date.now());
  const todos = await getCollection("todos");
  const open = todos.filter((t) => !t.done && VERIFIABLE.some((r) => r.title.test(t.title)));
  let closed = 0;
  for (const t of open.slice(0, 12)) {
    const ev = await findCompletion(t);
    if (!ev) continue;
    t.done = true;
    t.detail = `Already done — ${ev.where}.${t.detail ? " " + t.detail : ""}`;
    closed++;
    await addAudit({ kind: "executed", summary: `Marked “${t.title}” done — found proof in ${ev.where}`, by: "hq", privateTo: t.privateTo });
  }
  if (closed) await setCollection("todos", todos);
  return closed;
}
