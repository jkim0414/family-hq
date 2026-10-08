// NOTE: .js extension required — imported from api/ (Vercel Node ESM).
// No imports of config.ts here: this file ships in the app, and config holds the family's details.

// ─────────────────────────────────────────────────────────────────────────────
// Timezone policy: events are STORED in their source zone (whatever the email,
// message, or Google Calendar event said — that preserves the true instant),
// but are always DISPLAYED in the family's home zone (PT). Shared by the app
// views and the emailed digest so they can't diverge.
// ─────────────────────────────────────────────────────────────────────────────

export const HOME_TZ = "America/Los_Angeles"; // the family's home zone (config.calendar.timeZone uses this)

// Intl.DateTimeFormat construction is the expensive part of every conversion
// (~0.5ms each); one formatter per zone, reused, makes this effectively free.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string, withSeconds: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${withSeconds ? 1 : 0}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(withSeconds ? "en-US" : "en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" } : {}),
      hour12: false,
    });
    fmtCache.set(key, f);
  }
  return f;
}

/** Minutes east of UTC for `tz` at instant `d` (e.g. PDT → -420). */
function offsetMin(d: Date, tz: string): number {
  const parts = formatter(tz, true).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - d.getTime()) / 60000);
}

/** The UTC instant of wall-clock `date` + `time` in `tz` (two-pass for DST edges). */
export function wallToUtc(date: string, time: string, tz: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  let off = offsetMin(guess, tz);
  let utc = new Date(guess.getTime() - off * 60000);
  const off2 = offsetMin(utc, tz);
  if (off2 !== off) utc = new Date(guess.getTime() - off2 * 60000);
  return utc;
}

/** Wall-clock date + HH:mm of instant `d` in `tz`. */
export function utcToWall(d: Date, tz: string): { date: string; time: string } {
  const parts = formatter(tz, false).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}` };
}

export interface EventTimes {
  date: string;
  start?: string;
  end?: string;
  endDate?: string;
  allDay: boolean;
  startTz?: string;
  endTz?: string;
}

export interface HomeZoneTimes {
  date: string; // start date in HOME_TZ
  start?: string; // HH:mm in HOME_TZ
  end?: string; // HH:mm in HOME_TZ
  endDate?: string; // end date in HOME_TZ, only if ≠ date
  converted: boolean; // true when the source zone differed from HOME_TZ
}

/**
 * An event's date/times expressed in the home zone (PT). Events without tz
 * fields are already home-zone wall times and pass through untouched; all-day
 * events are date-only and zone-less by definition.
 */
// Results are memoized by the event's time fields: the same event is converted
// many times per render (grouping, sorting, display), on every render.
const homeCache = new Map<string, HomeZoneTimes>();
const endCache = new Map<string, number>();
const timeKey = (e: EventTimes) => `${e.date}|${e.start || ""}|${e.end || ""}|${e.endDate || ""}|${e.allDay ? 1 : 0}|${e.startTz || ""}|${e.endTz || ""}`;

export function toHomeZone(e: EventTimes): HomeZoneTimes {
  const key = timeKey(e);
  const hit = homeCache.get(key);
  if (hit) return hit;
  if (homeCache.size > 4000) homeCache.clear();
  const out = computeHomeZone(e);
  homeCache.set(key, out);
  return out;
}

function computeHomeZone(e: EventTimes): HomeZoneTimes {
  const startTz = e.startTz || HOME_TZ;
  const endTz = e.endTz || startTz;
  if (e.allDay || !e.start) {
    return { date: e.date, start: undefined, end: undefined, endDate: undefined, converted: false };
  }
  const converted = startTz !== HOME_TZ || endTz !== HOME_TZ;
  const s = converted || startTz !== HOME_TZ ? utcToWall(wallToUtc(e.date, e.start, startTz), HOME_TZ) : { date: e.date, time: e.start };
  let end: string | undefined;
  let endDate: string | undefined;
  if (e.end) {
    const eWall = utcToWall(wallToUtc(e.endDate || e.date, e.end, endTz), HOME_TZ);
    end = eWall.time;
    if (eWall.date !== s.date) endDate = eWall.date;
  }
  return { date: s.date, start: s.time, end, endDate, converted };
}

/** "2:30 PM" from "14:30". */
export function fmt12(hhmm?: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, "0")} ${ampm}`;
}

/** Sort key: home-zone date + start time (all-day events first within a day). */
export function homeSortKey(e: EventTimes): string {
  const t = toHomeZone(e);
  return `${t.date} ${t.start || ""}`;
}

/** The UTC instant an event ends (for past/upcoming checks). */
export function eventEndUtc(e: EventTimes): Date {
  const key = timeKey(e);
  const hit = endCache.get(key);
  if (hit !== undefined) return new Date(hit);
  if (endCache.size > 4000) endCache.clear();
  const d = computeEndUtc(e);
  endCache.set(key, d.getTime());
  return d;
}

function computeEndUtc(e: EventTimes): Date {
  const startTz = e.startTz || HOME_TZ;
  const endTz = e.endTz || startTz;
  if (e.allDay || !e.start) return wallToUtc(e.date, "23:59", HOME_TZ);
  if (e.end) return wallToUtc(e.endDate || e.date, e.end, endTz);
  return wallToUtc(e.date, e.start, startTz);
}