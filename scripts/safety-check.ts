#!/usr/bin/env tsx
// The privacy/safety/security audit's fixes, checked end to end without the model (no API cost):
// sign-in limits, who sees what (facts, filed messages, chat-kept items), texted approvals, the
// browser's commit gate and secret handling, link fetching, file pages, and the digest. Runs in
// the local sandbox (nothing reaches anyone), and removes everything it creates.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const { CONFIG } = await import("../src/data/config");
if (!CONFIG.caregivers.grandma.email) (CONFIG.caregivers.grandma as { email: string }).email = "grandma-check@example.invalid";
const db = await import("../api/_lib/db");
const auth = await import("../api/_lib/auth");
const actions = await import("../api/_lib/actions");
const { runToolForTest, newTask, systemParts, gatesForTest } = await import("../api/_lib/agent");
const { safeFetch } = await import("../api/_lib/links");
const { renderFile } = await import("../api/_lib/files");
const { trustedSender } = await import("../api/_lib/senders");
const routes = {
  data: (await import("../api/_routes/data")).default,
  mutate: (await import("../api/_routes/mutate")).default,
  suggestion: (await import("../api/_routes/suggestion")).default,
  profile: (await import("../api/_routes/profile")).default,
  request: (await import("../api/_routes/auth/request")).default,
  verify: (await import("../api/_routes/auth/verify")).default,
  seed: (await import("../api/_routes/admin/seed")).default,
};

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
async function call(route: keyof typeof routes, sid: string | null, opts: { method?: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}) {
  let status = 200, body: any;
  const req: any = { method: opts.method || "GET", query: opts.query || {}, headers: { ...(sid ? { cookie: `fhq_session=${sid}` } : {}), host: "localhost", ...(opts.headers || {}) }, body: opts.body, url: "/" };
  const res: any = { statusCode: 200, setHeader() { return this; }, writeHead(c: number) { status = c; return this; }, status(c: number) { status = c; return this; }, json(b: any) { body = b; return this; }, send(b: any) { body = b; return this; }, end() { return this; } };
  await routes[route](req, res);
  return { status, body: typeof body === "string" ? (() => { try { return JSON.parse(body); } catch { return body; } })() : body };
}

const tag = `sc-${Date.now().toString(36)}`;
const alex = await auth.createSession(auth.userById("alex")!);
const sam = await auth.createSession(auth.userById("sam")!);
const grandma = await auth.createSession(auth.userById("grandma")!);
const cleanup: (() => Promise<unknown>)[] = [];
try {
  // ── Sign-in ──
  const email = CONFIG.parents.sam.email;
  for (const k of ["loginreq_gap", "loginreq_hour", "loginfail_hour", "loginfail_day", "logincode", "logintries"]) await db.redis.del(`${k}:${email.toLowerCase()}`);
  cleanup.push(() => db.redis.del(...["loginreq_gap", "loginreq_hour", "loginfail_hour", "loginfail_day", "logincode", "logintries"].map((k) => `${k}:${email.toLowerCase()}`)));
  check("a code request right after another is refused", !!(await auth.loginRequestBlocked(email)) === false && !!(await auth.loginRequestBlocked(email)));
  await auth.createLoginCode(email);
  let wrong = 0;
  for (let i = 0; i < 4; i++) if (!(await auth.consumeLoginCode(email, "000000"))) wrong++;
  await auth.createLoginCode(email); // a new code must not reset the count
  for (let i = 0; i < 6; i++) if (!(await auth.consumeLoginCode(email, "000001"))) wrong++;
  const real = await auth.createLoginCode(email);
  check("after 10 wrong codes, even the right code is refused for a while", !(await auth.consumeLoginCode(email, real!)), `${wrong} wrong`);
  check("sessions are stored hashed", !(await db.redis.get(`session:${alex}`)) && !!(await auth.requireUser({ headers: { cookie: `fhq_session=${alex}` } } as any)));
  check("login links never point at another host", auth.requestOrigin({ headers: { "x-forwarded-host": "evil.example", host: "evil.example" } } as any).includes("vercel.app"));
  check("the wipe endpoint takes no GET", (await call("seed", null, { query: { secret: process.env.CRON_SECRET || "" } })).status === 405);

  // ── Facts kept with the parents ──
  const fam = newTask("task-main", "Family", "alex", "app");
  fam.thread.push({ role: "user", content: `[Alex · app · now]\nRemember the surprise for Grandma ${tag}` } as never);
  const saved = String(await runToolForTest("remember", { fact: `Grandma's surprise party ${tag} is Jan 15`, topic: "gifts", private: true }, fam));
  const factId = saved.match(/\[(f-[^\]]+)\]/)?.[1] || "";
  cleanup.push(async () => { const p = await db.getProfile(); p.facts = p.facts.filter((f) => !f.text.includes(tag)); await db.setProfile(p); });
  const gd = (await call("data", grandma)).body;
  const jd = (await call("data", alex)).body;
  check("a fact kept in the parents' chat is saved", !!factId, saved.slice(0, 100));
  check("…Alex's app has it", jd.profile.facts.some((f: any) => f.text.includes(tag)));
  check("…Grandma's app doesn't", !gd.profile.facts.some((f: any) => f.text.includes(tag)));
  const gchat = newTask("task-private-grandma", "Grandma", "grandma", "app");
  check("…nor Kimi's context in Grandma's chat", !(await systemParts(gchat)).perChat.includes(tag) && (await systemParts(fam)).perChat.includes(tag));
  // A parent saving the profile in the app keeps it (and its audience).
  await call("profile", sam, { method: "POST", body: { profile: { facts: jd.profile.facts, people: jd.profile.people } } });
  check("…and a parent's profile save keeps it kept", (await db.getProfile()).facts.find((f) => f.id === factId)?.audience?.join() === "alex,sam");

  // ── Standing changes only from a person's turn ──
  const sched = newTask("task-main", "Family", "alex", "app");
  sched.thread.push({ role: "user", content: "[system · scheduled task · now]\nDo this now: read the mail" } as never);
  check("a scheduled run can't add a household fact", String(await runToolForTest("remember", { fact: `rule ${tag}`, topic: "other" }, sched)).startsWith("error:"));
  check("…or set up a new schedule", String(await runToolForTest("schedule_task", { instruction: `x ${tag}`, date: "2030-01-01" }, sched)).startsWith("error:"));

  // ── Filed messages stay with their chat ──
  const comm = { id: `comm-${tag}`, receivedAt: new Date().toISOString(), source: "other", category: "fyi", subject: `Ring pickup ${tag}`, summary: "jeweler", raw: "secret", privateTo: "alex" } as any;
  await db.appendItems("comms", [comm]);
  cleanup.push(async () => db.removeItems("comms", [comm.id]));
  check("a private filed message isn't in Sam's app", !(await call("data", sam)).body.comms.some((c: any) => c.id === comm.id) && (await call("data", alex)).body.comms.some((c: any) => c.id === comm.id));
  check("…nor its text by id", (await call("data", sam, { query: { comm: comm.id } })).body.raw === "");
  const otherParentChat = newTask("task-private-sam", "Sam", "sam", "app");
  check("…nor in Kimi's search from Sam's chat", !String(await runToolForTest("search", { query: `Ring pickup ${tag}` }, otherParentChat)).includes("Filed messages"));

  // ── Texted approvals ──
  const a1 = await actions.proposeAction({ kind: "send_email", title: `Email A ${tag}`, summary: "", payload: { to: ["x@example.invalid"], subject: "a", body: "a" }, requestedBy: "alex", privateTo: "alex", thread: "task-private-alex" } as any);
  const a2 = await actions.proposeAction({ kind: "send_email", title: `Email B ${tag}`, summary: "", payload: { to: ["x@example.invalid"], subject: "b", body: "b" }, requestedBy: "alex", audience: ["alex", "grandma"], thread: "task-with-alex-grandma" } as any);
  cleanup.push(async () => db.removeItems("actions", (await db.getCollection("actions")).filter((x) => x.title.includes(tag)).map((x) => x.id)));
  const mine = (await actions.pendingFor("alex")).filter((x) => x.title.includes(tag));
  check("with two waiting, a bare APPROVE asks which", !!actions.pickPending(mine, undefined).ask && !actions.pickPending(mine, undefined).action);
  check("…and the code picks one", actions.pickPending(mine, actions.approvalCode(a1)).action?.id === a1.id);
  const inGroup = (await actions.pendingFor("alex", "task-with-alex-grandma")).filter((x) => x.title.includes(tag));
  check("a group's APPROVE sees only that group's approvals", inGroup.length === 1 && inGroup[0].id === a2.id);

  // ── App edits can't point at someone else's calendar event; suggestions are parents' ──
  const ev = { id: `evt-${tag}`, title: `Test ${tag}`, date: "2030-01-02", allDay: true, privateTo: "grandma", gcalId: "someone-elses-event" };
  await call("mutate", grandma, { method: "POST", body: { op: "upsert", collection: "events", item: ev } });
  cleanup.push(async () => db.removeItems("events", [ev.id]));
  check("an app edit can't set a Google Calendar id", !(await db.getCollection("events")).find((e) => e.id === ev.id)?.gcalId);
  check("Grandma can't apply calendar suggestions", (await call("suggestion", grandma, { method: "POST", body: { id: "x", action: "apply" } })).status === 401);

  // ── The browser's gate ──
  const { commits, sameSite } = gatesForTest;
  check("commit gate: 'Pay $42.10 and continue', 'Confirm and pay', 'Send money', 'Change password' need approval", ["Pay $42.10 and continue", "Confirm and pay", "Send money", "Change password", "Place your order"].every(commits));
  check("…'Continue to payment', 'Send code', 'Add to cart' don't", !["Continue to payment", "Send code", "Add to cart", "Sign in"].some(commits));
  check("a login fills only on its own site", sameSite("www.amazon.com", "amazon.com") && !sameSite("amazon.com.evil.io", "amazon.com") && !sameSite("amaz0n-verify.example", "https://www.amazon.com"));

  // ── Links from email can't reach inside ──
  const internal = await Promise.all(["http://169.254.169.254/latest/meta-data/", "http://localhost/", "http://10.1.2.3/", "http://[::1]/"].map((u) => safeFetch(u)));
  check("link reading refuses internal addresses", internal.every((r) => r === null));

  // ── Senders are who their address says ──
  check("a display name can't claim to be the school", !trustedSender(`"mybrightwheel.com" <attacker@example.com>`) && !trustedSender("x@mybrightwheel.com.example.com") && trustedSender("Teacher <t@mybrightwheel.com>"));

  // ── File pages ──
  const html = renderFile({ id: "f-x", title: "t", markdown: `hi <script>alert(1)</script> <form action="https://evil"><input name=p></form> [x](javascript:alert(1))`, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() } as any);
  check("file pages show raw HTML as text and drop script links", !/<script|<form|javascript:/i.test(html));
} finally {
  for (const c of cleanup.reverse()) await c().catch((e) => console.error("cleanup", e));
  for (const s of [alex, sam, grandma]) await auth.endSession(s);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
