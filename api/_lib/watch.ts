import { recordUsage } from "./usage.js";
import Anthropic from "@anthropic-ai/sdk";
import { redis } from "./db.js";
import { fetchRecent, inboxConfigured, type RecentMessage } from "./imap.js";
import { fileMessages, type FileInput } from "./file-mail.js";
import { recordReceipts } from "./receipts.js";
import { KIDS } from "../../src/data/kids.js";

// ─────────────────────────────────────────────────────────────────────────────
// Inbox watching: read each parent's own Gmail as mail arrives and file what's
// relevant to the household — no forwarding step. Two gates keep it precise
// and private:
//   1. Known senders (school, activities, daycare, medical, travel) and any
//      subject naming a kid go straight to the filing pipeline.
//   2. Everything else is triaged on HEADERS + a short excerpt only; a small
//      model answers "is this about the kids / household?" and only a yes
//      pulls the full message in. Bank statements, work, newsletters stay put.
// Seen-tracking: one sorted set per mailbox (UIDVALIDITY), member = UID, score = when
// seen; entries older than the lookback window are pruned. One lookup and one write per
// pass instead of a command per message, so nothing is filed twice.
// ─────────────────────────────────────────────────────────────────────────────

export type Parent = "alex" | "sam";
const PARENTS: Parent[] = ["alex", "sam"];

const LOOKBACK_DAYS = 2;
const SEEN_TTL_S = 6 * 86400;
const MIN_INTERVAL_MS = 15 * 60 * 1000;
const TRIAGE_MODEL = process.env.TRIAGE_MODEL || "claude-haiku-4-5";

// Senders that are always household-relevant. Add here as misses show up in History.
const KNOWN_SENDERS: RegExp[] = [
  // Add your school district's and schools' email domains here, e.g. /yourdistrict\.org/i,
  /brightwheel/i,
  /band\.us/i,
  /parentsquare/i,
  /leagueapps/i,
  /teamsnap/i,
  /ayso/i,
  /signupgenius/i,
  // Add your pediatrician's / health system's email domain here if you want it filed.
  /activecommunities|activenet/i,
  /dentist|pediatric|orthodont/i,
];
// Relevant only when the subject says so — these senders also send marketing and account noise.
const CONDITIONAL_SENDERS: { from: RegExp; subject: RegExp }[] = [
  { from: /paperlesspost|evite|punchbowl|partiful/i, subject: /invit|rsvp|party|birthday|celebrat/i },
  { from: /united\.com|delta\.com|alaskaair|jetblue|southwest\.com|aa\.com/i, subject: /itinerary|confirmation|reservation|receipt|check-?in|flight|boarding|cancel|change/i },
  { from: /airbnb|vrbo|marriott|hilton|hyatt|aloft|ihg|booking\.com|hotels\.com/i, subject: /itinerary|confirmation|reservation|your stay|booking|check-?in|cancel/i },
];
// Never worth a look, even by the triage model.
const IGNORE_SENDERS: RegExp[] = [
  /accounts\.google\.com|no-?reply@google/i,
  /calendar-notification@google\.com/i,
  /mailer-daemon|postmaster/i,
  /assistant@example\.com/i, // Kimi's own mail (digests, alerts)
  /noreply@(github|vercel|linear|slack|notion|figma)\.com/i,
];
// Google Calendar traffic is already mirrored from the Personal calendar.
const IGNORE_SUBJECTS: RegExp[] = [/^(Invitation|Updated invitation|Accepted|Declined|Tentatively accepted|Canceled event|Cancelled event|New event):/i];

const client = new Anthropic();

export interface WatchStats {
  ran: boolean;
  parents: Record<string, { fetched: number; direct: number; triaged: number; relevant: number; filed: number; duplicates: number; receipts?: number; error?: string }>;
}

const seenSetKey = (p: Parent, uidv: number) => `watch_seenz:${p}:${uidv}`;

/** Which of these UIDs a previous pass already looked at — one ZMSCORE. */
function seenLookup(p: Parent) {
  return async (uidv: number, uids: number[]): Promise<Set<number>> => {
    const scores = (await redis.zmscore(seenSetKey(p, uidv), uids)) || [];
    return new Set(uids.filter((_, i) => scores[i] !== null && scores[i] !== undefined));
  };
}

/** Mark messages seen (one ZADD per mailbox) and drop entries past the retention window. */
async function markSeenMany(p: Parent, msgs: RecentMessage[]): Promise<void> {
  const now = Date.now();
  const byBox = new Map<number, number[]>();
  for (const m of msgs) (byBox.get(m.uidValidity) || byBox.set(m.uidValidity, []).get(m.uidValidity)!).push(m.uid);
  for (const [uidv, uids] of byBox) {
    const [first, ...rest] = uids.map((uid) => ({ score: now, member: uid }));
    await redis.zadd(seenSetKey(p, uidv), first, ...rest);
    await redis.zremrangebyscore(seenSetKey(p, uidv), 0, now - SEEN_TTL_S * 1000);
  }
}

const isOn = (v: unknown) => v === 1 || v === "1" || v === true;

export async function watchEnabled(p: Parent): Promise<boolean> {
  return isOn(await redis.get(`watch:${p}`));
}
export async function setWatch(p: Parent, on: boolean): Promise<void> {
  if (on) await redis.set(`watch:${p}`, "1");
  else await redis.del(`watch:${p}`);
}

function kidNamesRe(): RegExp {
  const names = KIDS.map((k) => k.firstName).filter(Boolean);
  return new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
}

function ignorable(m: RecentMessage): boolean {
  return IGNORE_SENDERS.some((re) => re.test(m.from)) || IGNORE_SUBJECTS.some((re) => re.test(m.subject));
}

function directlyRelevant(m: RecentMessage, kids: RegExp): boolean {
  return KNOWN_SENDERS.some((re) => re.test(m.from)) || CONDITIONAL_SENDERS.some((c) => c.from.test(m.from) && c.subject.test(m.subject)) || kids.test(m.subject);
}

/** Headers + a short excerpt → which of these are about the household? (indices) */
async function triage(msgs: RecentMessage[]): Promise<Set<number>> {
  if (!msgs.length) return new Set();
  const kids = KIDS.map((k) => `${k.firstName} (${k.current.program}, ${k.current.school})`).join("; ");
  const lines = msgs.map((m, i) => `${i}. From: ${m.from.slice(0, 80)} | Subject: ${m.subject.slice(0, 120)} | Excerpt: ${m.text.replace(/\s+/g, " ").slice(0, 160)}`);
  const res = await client.messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 300,
    system: `You triage a family's email for their household assistant. Kids: ${kids}. Parents: Alex and Sam.
Mark an email RELEVANT only if it is about: the kids (school, teachers, classes, activities, sports, camps, daycare, playdates, birthday invitations, health/appointments), family logistics (appointments, deliveries the family must act on, travel itineraries, reservations, household services like cleaners/repairs), or something a parent must do by a date for the household.
NOT relevant: work email, finance/banking/investing/statements/credit, marketing and promotions, newsletters, receipts for routine purchases, social media, software/service notifications, political/charity asks, personal correspondence with no household action.
Reply with ONLY a JSON array of the relevant indices, e.g. [0,3]. Empty array if none.`,
    messages: [{ role: "user", content: lines.join("\n") }],
  });
  recordUsage("triage", TRIAGE_MODEL, res.usage);
  const text = res.content.find((b) => b.type === "text")?.text || "[]";
  const m = text.match(/\[[\d,\s]*\]/);
  const arr: unknown = m ? JSON.parse(m[0]) : [];
  return new Set(Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n) && n >= 0 && n < msgs.length) : []);
}

/** What a watch pass WOULD file for one parent, without filing or marking anything (for tuning the gates). */
export async function previewWatch(p: Parent, days = LOOKBACK_DAYS): Promise<{ direct: RecentMessage[]; relevant: RecentMessage[]; ignored: RecentMessage[]; triagedOut: RecentMessage[] }> {
  const kids = kidNamesRe();
  const msgs = await fetchRecent(p, { days, max: 120, seen: async () => new Set() });
  const ignored = msgs.filter((m) => ignorable(m));
  const candidates = msgs.filter((m) => !ignored.includes(m));
  const direct = candidates.filter((m) => directlyRelevant(m, kids));
  const rest = candidates.filter((m) => !directlyRelevant(m, kids));
  const keep = rest.length ? await triage(rest) : new Set<number>();
  return { direct, relevant: rest.filter((_, i) => keep.has(i)), triagedOut: rest.filter((_, i) => !keep.has(i)), ignored };
}

/**
 * One pass over both parents' inboxes. Time-gated to ~15 min; returns ran:false when skipped.
 * The cron passes `pre` (the watch toggles and last-run time, read in its one batched MGET)
 * so an idle tick costs no extra commands here.
 */
export async function runWatch(opts: { quiet?: boolean; budgetMs: number; pre?: { enabled: Record<Parent, unknown>; last: number } }): Promise<WatchStats> {
  const stats: WatchStats = { ran: false, parents: {} };
  const active: Parent[] = [];
  for (const p of PARENTS) if (inboxConfigured(p) && (opts.pre ? isOn(opts.pre.enabled[p]) : await watchEnabled(p))) active.push(p);
  if (!active.length) return stats;

  const last = opts.pre ? opts.pre.last : Number((await redis.get<number>("watch_last")) || 0);
  if (Date.now() - last < MIN_INTERVAL_MS) return stats;
  if (!(await redis.set("watch_lock", "1", { nx: true, ex: 240 }))) return stats;
  await redis.set("watch_last", Date.now());
  stats.ran = true;
  const deadline = Date.now() + opts.budgetMs;
  const kids = kidNamesRe();

  try {
    for (const p of active) {
      if (Date.now() > deadline) break;
      const s = { fetched: 0, direct: 0, triaged: 0, relevant: 0, filed: 0, duplicates: 0 } as WatchStats["parents"][string];
      stats.parents[p] = s;
      try {
        const msgs = await fetchRecent(p, {
          days: LOOKBACK_DAYS,
          max: 60,
          seen: seenLookup(p),
        });
        s.fetched = msgs.length;
        const candidates = msgs.filter((m) => !ignorable(m));
        const direct = candidates.filter((m) => directlyRelevant(m, kids));
        const rest = candidates.filter((m) => !directlyRelevant(m, kids));
        s.direct = direct.length;
        s.triaged = rest.length;
        const keep = rest.length ? await triage(rest) : new Set<number>();
        const relevant = [...direct, ...rest.filter((_, i) => keep.has(i))];
        s.relevant = relevant.length;

        const inputs: FileInput[] = relevant.map((m) => ({ ...m, key: `w${p[0]}-${m.uidValidity}-${m.uid}`, mailbox: p }));
        const r = await fileMessages(inputs, { quiet: opts.quiet });
        s.filed = r.filed;
        s.duplicates = r.duplicates;

        // Receipts go to the spending log (separately from filing — most aren't "household" mail).
        s.receipts = await recordReceipts(p, candidates).catch((e) => {
          console.error(`receipts ${p} failed`, e);
          return 0;
        });

        // Everything fetched this run is now "seen" — relevant or not.
        if (msgs.length) await markSeenMany(p, msgs);
      } catch (e) {
        s.error = String((e as Error).message || e).slice(0, 200);
        console.error(`watch ${p} failed`, e);
      }
    }
  } finally {
    await redis.del("watch_lock").catch(() => {});
  }
  return stats;
}
