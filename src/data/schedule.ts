import { wallToUtc, HOME_TZ, fmt12 } from "./tz.js";
import type { Schedule, Repeat } from "./types";

// Pure date logic for scheduled / recurring tasks — shared by the server (running them)
// and the app (showing "Every month on the last day at 9:00 AM").

const DAY = 86400000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ── Dates (YYYY-MM-DD strings, calendar arithmetic in UTC) ───────────────────
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => toDate(toMs(d) + n * DAY);
const dow = (d: string) => new Date(toMs(d)).getUTCDay();
const ymd = (d: string) => d.split("-").map(Number) as [number, number, number];
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
export const todayHome = () => new Date().toLocaleDateString("en-CA", { timeZone: HOME_TZ });
export const nowHomeTime = () => new Date().toLocaleTimeString("en-GB", { timeZone: HOME_TZ, hour: "2-digit", minute: "2-digit", hour12: false });

/** Parse "mon", "Tuesday", 2 … into 0–6. */
export function weekdayIndex(v: string | number): number | null {
  if (typeof v === "number") return v >= 0 && v <= 6 ? v : null;
  const i = WEEKDAYS.findIndex((w) => w.startsWith(v.trim().toLowerCase().slice(0, 3)));
  return i >= 0 ? i : null;
}

/** Does date `d` match the repeat rule, counted from `anchor`? */
function matches(d: string, r: Repeat, anchor: string): boolean {
  const every = Math.max(1, Math.floor(r.interval || 1));
  const [y, m, day] = ymd(d);
  const [ay, am, ad] = ymd(anchor);
  switch (r.freq) {
    case "daily":
      return Math.round((toMs(d) - toMs(anchor)) / DAY) % every === 0;
    case "weekly": {
      const days = r.weekdays?.length ? r.weekdays : [dow(anchor)];
      if (!days.includes(dow(d))) return false;
      // Whole weeks between the Sunday-starting weeks of d and anchor.
      const weeks = Math.round((toMs(addDays(d, -dow(d))) - toMs(addDays(anchor, -dow(anchor)))) / (7 * DAY));
      return weeks % every === 0;
    }
    case "monthly": {
      const months = (y - ay) * 12 + (m - am);
      if (months % every !== 0) return false;
      const last = daysInMonth(y, m);
      if (r.nth) {
        if (dow(d) !== r.nth.weekday) return false;
        if (r.nth.n === -1) return day + 7 > last;
        return Math.ceil(day / 7) === r.nth.n;
      }
      const want = r.monthDay ?? ad;
      if (want === -1) return day === last;
      return day === Math.min(want, last); // the 31st in a 30-day month runs on the 30th
    }
    case "yearly": {
      if ((y - ay) % every !== 0) return false;
      return m === am && day === Math.min(ad, daysInMonth(y, m));
    }
  }
}

/** The first date strictly after `after` (or on it, if inclusive) that the rule hits, within ~5 years. */
export function nextDate(r: Repeat, anchor: string, after: string, inclusive = false): string | null {
  let d = inclusive ? after : addDays(after, 1);
  if (d < anchor) d = anchor;
  for (let i = 0; i < 366 * 5; i++, d = addDays(d, 1)) {
    if (r.until && d > r.until) return null;
    if (matches(d, r, anchor)) return d;
  }
  return null;
}

/** When a schedule should next fire, strictly after `afterIso` (defaults to now). */
export function computeNextRun(s: Pick<Schedule, "anchor" | "time" | "repeat">, afterIso = new Date().toISOString()): string | null {
  if (!s.repeat) {
    const at = wallToUtc(s.anchor, s.time, HOME_TZ).toISOString();
    return at > afterIso ? at : null;
  }
  const afterDay = new Date(afterIso).toLocaleDateString("en-CA", { timeZone: HOME_TZ });
  // Today still counts if its time hasn't passed.
  let d = nextDate(s.repeat, s.anchor, afterDay, true);
  while (d) {
    const at = wallToUtc(d, s.time, HOME_TZ).toISOString();
    if (at > afterIso) return at;
    d = nextDate(s.repeat, s.anchor, d);
  }
  return null;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
const listDays = (days: number[]) => {
  const sorted = [...days].sort();
  if (sorted.join() === "1,2,3,4,5") return "weekdays";
  if (sorted.join() === "0,6") return "weekends";
  return sorted.map((d) => SHORT[d]).join(", ");
};

/** "Every month on the last day at 9:00 AM" / "Once, Tue Oct 6 at 8:00 AM". */
export function describe(s: Pick<Schedule, "anchor" | "time" | "repeat">): string {
  const at = fmt12(s.time);
  const r = s.repeat;
  if (!r) {
    const label = new Date(`${s.anchor}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    return `Once, ${label} at ${at}`;
  }
  const n = Math.max(1, r.interval || 1);
  const [, am, ad] = ymd(s.anchor);
  let base: string;
  switch (r.freq) {
    case "daily":
      base = n === 1 ? "Every day" : `Every ${n} days`;
      break;
    case "weekly":
      base = `${n === 1 ? "Every week" : `Every ${n} weeks`} on ${listDays(r.weekdays?.length ? r.weekdays : [dow(s.anchor)])}`;
      break;
    case "monthly": {
      const every = n === 1 ? "Every month" : `Every ${n} months`;
      if (r.nth) base = `${every} on the ${r.nth.n === -1 ? "last" : ["first", "second", "third", "fourth", "fifth"][r.nth.n - 1]} ${WEEKDAYS[r.nth.weekday][0].toUpperCase() + WEEKDAYS[r.nth.weekday].slice(1)}`;
      else if ((r.monthDay ?? ad) === -1) base = `${every} on the last day`;
      else base = `${every} on the ${ordinal(r.monthDay ?? ad)}`;
      break;
    }
    case "yearly":
      base = `${n === 1 ? "Every year" : `Every ${n} years`} on ${MONTHS[am - 1]} ${ad}`;
      break;
  }
  return `${base} at ${at}${r.until ? `, until ${r.until}` : ""}`;
}

