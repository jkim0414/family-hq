import ical from "node-ical";
import { redis } from "./db.js";
import { getCal } from "./calendar.js";
import { utcToWall, fmt12, HOME_TZ } from "../../src/data/tz.js";

// ─────────────────────────────────────────────────────────────────────────────
// The parents' WORK calendars, read-only, as planning context. Never copied
// into the family agenda. Two ways in:
//   • google — the work calendar is shared with alex@example.com (the account
//     Kimi already uses for the family calendar); `id` is the work address.
//   • ics    — a private "publish calendar" link (Outlook / Microsoft 365, or
//     Google's secret iCal address).
// Free/busy-only shares work too: they come back as untitled "Busy" blocks.
// ─────────────────────────────────────────────────────────────────────────────

export type Parent = "alex" | "sam";
export interface WorkCalConfig {
  source: "google" | "ics";
  id: string; // work email (google) or https://…ics (ics)
}
export interface WorkBlock {
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
  title: string; // "Busy" when only free/busy is shared
  outOfOffice: boolean;
  /** A block the parent placed on their own calendar (no other attendees): Dropoff, DNS, travel, focus. Not a meeting. */
  hold: boolean;
  /** A commute hold — marks an in-office day. */
  travel: boolean;
  /** A flight or airport run — the parent is on a trip, not at the office. */
  trip?: boolean;
}

const TRAVEL_RE = /\b(travel|commute|commuting|drive|driving|train|transit|to the office|to office)\b/i;
// "UA 123 JFK to DEN", "travel/security", "flight to Denver", "airport".
const TRIP_RE = /\b(flight|flights|airport|security|boarding|layover)\b|\b[A-Z]{3} ?(to|→|-|–) ?[A-Z]{3}\b/;
function classify(title: string, hold: boolean): Pick<WorkBlock, "hold" | "travel" | "trip"> {
  const trip = hold && (TRIP_RE.test(title) || /\bflight\b/i.test(title));
  return { hold, trip, travel: hold && !trip && TRAVEL_RE.test(title) };
}

const cfgKey = (p: Parent) => `workcal:${p}`;
const CACHE_S = 10 * 60;

export async function getWorkCalConfig(p: Parent): Promise<WorkCalConfig | null> {
  return (await redis.get<WorkCalConfig>(cfgKey(p))) ?? null;
}
export async function setWorkCalConfig(p: Parent, cfg: WorkCalConfig | null): Promise<void> {
  if (cfg) await redis.set(cfgKey(p), cfg);
  else await redis.del(cfgKey(p));
  // drop cached reads for this parent
  const keys = await redis.keys(`workcal_cache:${p}:*`).catch(() => [] as string[]);
  if (keys.length) await redis.del(...keys);
}

/** Parse what a parent typed: an email → Google share, a URL → ICS feed. */
export function parseWorkCalInput(raw: string): WorkCalConfig | null {
  const v = raw.trim().replace(/^webcal:\/\//i, "https://");
  if (/^https?:\/\//i.test(v)) return { source: "ics", id: v };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { source: "google", id: v.toLowerCase() };
  return null;
}

// "Leave for PTA meeting" is a departure, not time off — only unambiguous phrases count.
const OOO_RE = /\b(ooo|out of (the )?office|vacation|pto|holiday|day off|days off|off work|on leave|parental leave|maternity leave|paternity leave|sick day|sick leave)\b/i;

async function readGoogle(id: string, from: Date, to: Date): Promise<WorkBlock[]> {
  const cal = await getCal();
  if (!cal) throw new Error("Google Calendar isn't connected");
  try {
    const res = await cal.events.list({ calendarId: id, timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: "startTime", maxResults: 250 });
    return (res.data.items || [])
      .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
      .filter((e) => !(e.attendees || []).some((a) => a.self && a.responseStatus === "declined"))
      .map((e) => {
        const allDay = !e.start?.dateTime;
        const title = e.summary || "Busy";
        // Anyone besides this calendar's owner (and meeting rooms) makes it a meeting.
        const others = (e.attendees || []).filter((a) => !a.self && !a.resource && a.email?.toLowerCase() !== id.toLowerCase());
        const hold = others.length === 0;
        return {
          start: e.start?.dateTime || `${e.start?.date}T00:00:00`,
          end: e.end?.dateTime || `${e.end?.date}T00:00:00`,
          allDay,
          title,
          outOfOffice: e.eventType === "outOfOffice" || (allDay && OOO_RE.test(title)),
          ...classify(title, hold),
        };
      });
  } catch (e: any) {
    // Not visible to alex@example.com: not shared yet, or shared as free/busy only
    // (which needs a Google permission Kimi doesn't hold). Try free/busy, then explain.
    if (e?.code !== 403 && e?.code !== 404) throw e;
    const notShared = new Error(`${id} isn't shared with alex@example.com yet — in that calendar's settings, share it with alex@example.com and pick "See all event details"`);
    const fb = await cal.freebusy.query({ requestBody: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id }] } }).catch(() => null);
    if (!fb) throw notShared;
    const cal0 = fb.data.calendars?.[id];
    if (cal0?.errors?.length) throw notShared;
    return (cal0?.busy || []).map((b) => ({ start: b.start!, end: b.end!, allDay: false, title: "Busy", outOfOffice: false, hold: false, travel: false }));
  }
}

async function readIcs(url: string, from: Date, to: Date): Promise<WorkBlock[]> {
  const r = await fetch(url, { headers: { "user-agent": "FamilyHQ/1.0" } });
  if (!r.ok) throw new Error(`calendar link returned ${r.status}`);
  const data = ical.sync.parseICS(await r.text());
  const out: WorkBlock[] = [];
  for (const ev of Object.values(data)) {
    if (!ev || (ev as any).type !== "VEVENT") continue;
    const e = ev as any;
    if ((e as any).status === "CANCELLED") continue;
    const allDay = (e.datetype as string) === "date";
    const title = (typeof e.summary === "string" ? e.summary : (e.summary as any)?.val) || "Busy";
    const dur = +new Date(e.end || e.start) - +new Date(e.start);
    const attendees = ([] as unknown[]).concat(e.attendee || []);
    const hold = attendees.length <= 1;
    const push = (s: Date) => {
      const end = new Date(+s + dur);
      if (end < from || s > to) return;
      out.push({ start: s.toISOString(), end: end.toISOString(), allDay, title, outOfOffice: allDay && OOO_RE.test(title), ...classify(title, hold) });
    };
    if (e.rrule) {
      const skip = new Set(Object.keys(e.exdate || {}).map((k) => new Date(k).toDateString()));
      for (const s of e.rrule.between(new Date(+from - 86400000), to, true)) {
        if (skip.has(s.toDateString())) continue;
        const moved = e.recurrences && Object.values(e.recurrences).find((r: any) => new Date(r.recurrenceid).toDateString() === s.toDateString());
        push(moved ? new Date((moved as any).start) : s);
      }
    } else push(new Date(e.start));
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Work blocks for a parent between two instants (cached briefly). */
export async function getWorkBlocks(p: Parent, from: Date, to: Date): Promise<WorkBlock[]> {
  const cfg = await getWorkCalConfig(p);
  if (!cfg) return [];
  const key = `workcal_cache:${p}:${from.toISOString().slice(0, 13)}:${to.toISOString().slice(0, 13)}`;
  const cached = await redis.get<WorkBlock[]>(key).catch(() => null);
  if (cached) return cached;
  const blocks = cfg.source === "google" ? await readGoogle(cfg.id, from, to) : await readIcs(cfg.id, from, to);
  await redis.set(key, blocks, { ex: CACHE_S }).catch(() => {});
  return blocks;
}

/** Human-readable schedule by day, in Pacific time — for the assistant. */
/**
 * One line per day. With availabilityOnly (for the caregiver), no titles — just when the parent
 * is busy, blocked, commuting (an office day), traveling, or out.
 */
export function formatBlocks(blocks: WorkBlock[], opts: { availabilityOnly?: boolean } = {}): string {
  if (!blocks.length) return "(nothing on the work calendar)";
  const label = (b: WorkBlock) => (b.outOfOffice ? "out of office" : b.trip ? "traveling" : b.travel ? "commute (office day)" : b.hold ? "blocked" : "busy");
  const byDay = new Map<string, string[]>();
  for (const b of blocks) {
    const s = utcToWall(new Date(b.start), HOME_TZ);
    const e = utcToWall(new Date(b.end), HOME_TZ);
    const day = b.allDay ? b.start.slice(0, 10) : s.date;
    const tag = b.outOfOffice ? " (OUT)" : b.trip ? " (hold: trip travel)" : b.travel ? " (hold: commute — office day)" : b.hold ? " (hold)" : "";
    const what = opts.availabilityOnly ? label(b) : `${b.title}${tag}`;
    const line = b.allDay ? `all day — ${what}` : `${fmt12(s.time)}–${fmt12(e.time)} ${what}`;
    (byDay.get(day) || byDay.set(day, []).get(day)!).push(line);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, lines]) => `${new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}: ${lines.join("; ")}`)
    .join("\n");
}

const dayOf = (b: WorkBlock) => (b.allDay ? b.start.slice(0, 10) : utcToWall(new Date(b.start), HOME_TZ).date);
const isWeekday = (d: string) => { const w = new Date(d + "T12:00:00Z").getUTCDay(); return w >= 1 && w <= 5; };

/** True when this parent commutes on (nearly) every workday in the window — then "office day" is noise. */
export function commutesDaily(blocks: WorkBlock[]): boolean {
  const workdays = new Set(blocks.filter((b) => !b.allDay && isWeekday(dayOf(b))).map(dayOf));
  const commuteDays = new Set(blocks.filter((b) => b.travel && isWeekday(dayOf(b))).map(dayOf));
  return workdays.size >= 3 && commuteDays.size >= workdays.size * 0.8;
}

/**
 * One line per day for the digest: "office day; 7 meetings, 10:00 AM–7:45 PM", "out of office",
 * "flight: UA 123 JFK to DEN". Holds (Dropoff, DNS, focus, duties) never count as meetings.
 * Pass `officeDays: false` for a parent who commutes every day.
 */
export function summarizeDay(blocks: WorkBlock[], day: string, opts: { officeDays?: boolean } = {}): string | null {
  const todays = blocks.filter((b) => (b.allDay ? b.start.slice(0, 10) <= day && day < b.end.slice(0, 10) : utcToWall(new Date(b.start), HOME_TZ).date === day));
  if (!todays.length) return null;
  // A whole day off vs. a few hours blocked as "out of office" (leaving early, an appointment).
  const dayOff = todays.find((b) => b.outOfOffice && (b.allDay || +new Date(b.end) - +new Date(b.start) >= 7 * 3600000));
  if (dayOff) return `out of office${dayOff.title && dayOff.title !== "Busy" ? ` (${dayOff.title})` : ""}`;
  const away = todays.filter((b) => b.outOfOffice && !b.allDay);
  // Holds (Dropoff, DNS, travel, focus) aren't meetings; a travel hold means an office day.
  const timed = todays.filter((b) => !b.allDay && !b.outOfOffice && !b.hold);
  const trips = todays.filter((b) => b.trip && /\b[A-Z]{3} ?(to|→|-|–) ?[A-Z]{3}\b/.test(b.title));
  const officeDay = opts.officeDays !== false && isWeekday(day) && !todays.some((b) => b.trip) && todays.some((b) => b.travel);
  const parts: string[] = [];
  if (officeDay) parts.push("office day");
  for (const t of trips) parts.push(`flight ${fmt12(utcToWall(new Date(t.start), HOME_TZ).time)} (${t.title.replace(/\s*\([A-Z0-9]{6}\)/g, "").trim()})`);
  if (timed.length) {
    const first = utcToWall(new Date(timed[0].start), HOME_TZ).time;
    const last = utcToWall(new Date(timed.reduce((m, b) => (b.end > m ? b.end : m), timed[0].end)), HOME_TZ).time;
    parts.push(`${timed.length} meeting${timed.length > 1 ? "s" : ""}, ${fmt12(first)}–${fmt12(last)}`);
  }
  for (const b of away) {
    const s = utcToWall(new Date(b.start), HOME_TZ).time, e = utcToWall(new Date(b.end), HOME_TZ).time;
    parts.push(`out ${fmt12(s)}–${fmt12(e)}${b.title && b.title !== "Busy" ? ` (${b.title})` : ""}`);
  }
  if (!parts.length) return todays.some((b) => b.hold) ? "no meetings" : todays.map((b) => b.title).join(", ");
  return parts.join("; ");
}
