import { getCollection, setCollection, redis } from "./db.js";
import { memberName } from "./privacy.js";
import { HOME_TZ } from "../../src/data/tz.js";
import { nextDate, computeNextRun, describe, todayHome, nowHomeTime, addDays } from "../../src/data/schedule.js";
import type { Schedule, Repeat, Channel, Member } from "../../src/data/types";

export { nextDate, computeNextRun, describe, weekdayIndex, todayHome } from "../../src/data/schedule.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled and recurring tasks: "check on X next Tuesday", "every last day of
// the month, recap our spending". Each schedule is its own record (so any number
// can be pending), remembers who asked (they get the result, in the channel they
// used), and re-arms itself after each run. The per-minute cron reads only one
// key — the earliest next run — until something is due.
// ─────────────────────────────────────────────────────────────────────────────

export const NEXT_KEY = "schedules_next"; // ms timestamp of the earliest active nextRunAt
const LATE_LIMIT_MS = 24 * 3600 * 1000; // a run missed by more than a day is skipped, not replayed

/** Keep the cron's "earliest next run" key in step with the collection. */
async function syncNextKey(all: Schedule[]): Promise<void> {
  const next = all.filter((s) => s.active && s.nextRunAt).map((s) => Date.parse(s.nextRunAt!)).sort((a, b) => a - b)[0];
  if (next) await redis.set(NEXT_KEY, next);
  else await redis.del(NEXT_KEY);
}

async function save(all: Schedule[]): Promise<void> {
  // Keep every active schedule and the 30 most recent finished ones.
  const active = all.filter((s) => s.active);
  const done = all.filter((s) => !s.active).sort((a, b) => (b.lastRunAt || b.createdAt).localeCompare(a.lastRunAt || a.createdAt)).slice(0, 30);
  const kept = [...active, ...done];
  await setCollection("schedules", kept);
  await syncNextKey(kept);
}

export interface NewSchedule {
  title: string;
  instruction: string;
  owner: Member;
  notify?: "owner" | "both";
  channel: Channel;
  /** "YYYY-MM-DD" and/or "HH:mm" of the first run; for repeats the date may be omitted (next match from today). */
  date?: string;
  time?: string;
  repeat?: Repeat;
  /** The chat thread it runs in and reports to; private when started from a "Just me" thread. */
  thread?: string;
  privateTo?: Member;
  /** Kept within a shared chat's members. */
  audience?: Member[];
}

/** Validate, compute the first run, and store. Throws with a readable message on bad input. */
export async function createSchedule(input: NewSchedule): Promise<Schedule> {
  const time = /^\d{1,2}:\d{2}$/.test(input.time || "") ? input.time!.padStart(5, "0") : "08:00";
  if (Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new Error("time must be HH:mm (24-hour)");
  let anchor = /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date! : "";
  const r = input.repeat ? { ...input.repeat } : undefined;
  if (r) {
    if (!["daily", "weekly", "monthly", "yearly"].includes(r.freq)) throw new Error("repeat.freq must be daily, weekly, monthly, or yearly");
    if (r.interval && (r.interval < 1 || r.interval > 52)) throw new Error("repeat.interval must be 1–52");
    if (r.weekdays) r.weekdays = r.weekdays.filter((d) => d >= 0 && d <= 6);
    if (r.monthDay !== undefined && !(r.monthDay === -1 || (r.monthDay >= 1 && r.monthDay <= 31))) throw new Error("repeat.monthDay must be 1–31 or -1 (last day)");
    if (r.nth && (!(r.nth.n === -1 || (r.nth.n >= 1 && r.nth.n <= 5)) || r.nth.weekday < 0 || r.nth.weekday > 6)) throw new Error("repeat.nth must be {n: 1–5 or -1, weekday: 0–6}");
    if (!anchor) {
      // First matching day from today (today counts if the time is still ahead).
      const today = todayHome();
      const probe: Repeat = { ...r };
      // Anchor on a day that satisfies the rule itself, so intervals count from a real occurrence.
      let d = nextDate({ ...probe, interval: 1 }, today, today, true);
      if (d === today && time <= nowHomeTime()) d = nextDate({ ...probe, interval: 1 }, today, today);
      if (!d) throw new Error("that repeat never happens");
      anchor = d;
    }
  } else if (!anchor) {
    // One-time with only a time: today if still ahead, else tomorrow.
    anchor = time > nowHomeTime() ? todayHome() : addDays(todayHome(), 1);
  }
  const s: Schedule = {
    id: `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    title: input.title.trim().slice(0, 80) || input.instruction.trim().slice(0, 60),
    instruction: input.instruction.trim().slice(0, 1500),
    owner: input.owner,
    notify: input.notify === "both" ? "both" : "owner",
    channel: input.channel,
    thread: input.thread,
    privateTo: input.privateTo,
    audience: input.audience,
    time,
    anchor,
    repeat: r,
    active: true,
    createdAt: new Date().toISOString(),
    runs: 0,
  };
  const next = computeNextRun(s);
  if (!next) throw new Error(r ? "that repeat has no future runs (check the end date)" : "that time is in the past");
  s.nextRunAt = next;
  const all = await getCollection("schedules");
  all.push(s);
  await save(all);
  return s;
}

/** The chat threads that have a schedule due now (so the runner can lock each one before claiming). */
export async function dueThreads(nowIso = new Date().toISOString()): Promise<string[]> {
  const all = await getCollection("schedules");
  return [...new Set(all.filter((s) => s.active && s.nextRunAt && s.nextRunAt <= nowIso).map((s) => s.thread || "task-main"))];
}

export async function listSchedules(): Promise<Schedule[]> {
  return (await getCollection("schedules")).filter((s) => s.active).sort((a, b) => (a.nextRunAt || "").localeCompare(b.nextRunAt || ""));
}

/** Cancel by id, or by a unique title match. Returns the cancelled schedule or null. */
export async function cancelSchedule(idOrTitle: string): Promise<Schedule | null | "ambiguous"> {
  const all = await getCollection("schedules");
  const want = idOrTitle.trim().toLowerCase();
  let hit = all.filter((s) => s.active && s.id === idOrTitle);
  if (!hit.length) hit = all.filter((s) => s.active && s.title.toLowerCase().includes(want));
  if (hit.length > 1) return "ambiguous";
  if (!hit.length) return null;
  hit[0].active = false;
  hit[0].nextRunAt = undefined;
  await save(all);
  return hit[0];
}

export function fmtSchedule(s: Schedule): string {
  const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString("en-US", { timeZone: HOME_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
  const who = s.notify === "both" ? "both parents" : memberName(s.owner);
  return `• [${s.id}] ${s.title} — ${describe(s)} · next: ${next} · reports to ${who}`;
}

/**
 * Claim the schedules that are due: re-arm each (next occurrence, or finished) BEFORE running,
 * so a crash can't fire it twice. Returns what to run now. Runs missed by more than a day are
 * skipped (re-armed without running) rather than replayed.
 */
export async function claimDue(nowIso = new Date().toISOString(), limit = Infinity, pick: (s: Schedule) => boolean = () => true): Promise<Schedule[]> {
  if (!(await redis.set("schedules_lock", "1", { nx: true, ex: 60 }))) return [];
  try {
    const all = await getCollection("schedules");
    const due: Schedule[] = [];
    let changed = false;
    for (const s of all) {
      if (!s.active || !s.nextRunAt || s.nextRunAt > nowIso || !pick(s)) continue;
      if (due.length >= limit) break;
      const late = Date.parse(nowIso) - Date.parse(s.nextRunAt) > LATE_LIMIT_MS;
      if (!late) due.push({ ...s });
      s.lastRunAt = nowIso;
      s.runs = (s.runs || 0) + (late ? 0 : 1);
      const next = s.repeat ? computeNextRun(s, nowIso) : null;
      s.nextRunAt = next || undefined;
      s.active = !!next;
      changed = true;
    }
    if (changed) await save(all);
    else await syncNextKey(all); // heal a stale key
    return due;
  } finally {
    await redis.del("schedules_lock").catch(() => {});
  }
}
