import { redis } from "./db.js";
import { getWorkBlocks, normTitle, formatBlocks, type WorkBlock, type Parent } from "./workcal.js";
import { PARENTS, memberName } from "./privacy.js";
import { titlesSimilar } from "./util.js";
import { onCalendar } from "../../src/data/invites.js";
import { toHomeZone, wallToUtc, utcToWall, HOME_TZ, fmt12 } from "../../src/data/tz.js";
import type { CalEvent, Member } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// A family event against the parents' work calendars. When something lands on the family calendar
// (a school event from a digest, a party they said yes to, something added in chat) that a parent
// it's for can't make as their work day stands — a meeting, an office day, a trip — Kimi says so
// with the specifics and what she'd do about it. Each event is checked once (again if its time
// changes, or a new work conflict appears); a repeating event is checked once for the series.
// ─────────────────────────────────────────────────────────────────────────────

export interface Clash {
  parent: Parent;
  kind: "meeting" | "office" | "out" | "trip";
  /** Stable per thing it collides with: a flagged clash isn't flagged again. */
  key: string;
  line: string;
}

const HORIZON_DAYS = 42; // far enough to catch a meeting booked weeks out, while it's easy to move
const seenKey = "conflicts_seen";
const DEFAULT_TRAVEL_MIN = 15;

/** The event's span in real time, padded by the drive there and back. */
export function eventWindow(e: CalEvent): { from: Date; to: Date; day: string } | null {
  if (e.allDay || !e.start) return null;
  const h = toHomeZone(e);
  if (!h.start) return null;
  const start = wallToUtc(h.date, h.start, HOME_TZ);
  const end = h.end ? wallToUtc(h.endDate || h.date, h.end, HOME_TZ) : new Date(+start + 3600000);
  const pad = (e.travelMin ?? DEFAULT_TRAVEL_MIN) * 60000;
  return { from: new Date(+start - pad), to: new Date(Math.max(+end, +start + 15 * 60000) + pad), day: h.date };
}

const span = (b: WorkBlock) => {
  const s = utcToWall(new Date(b.start), HOME_TZ), e = utcToWall(new Date(b.end), HOME_TZ);
  return `${fmt12(s.time)}–${fmt12(e.time)}`;
};
const blockDay = (b: WorkBlock) => (b.allDay ? b.start.slice(0, 10) : utcToWall(new Date(b.start), HOME_TZ).date);
const where = (b: WorkBlock) => [b.location ? `at ${b.location}` : "", b.video ? "has a video link" : ""].filter(Boolean).join(", ");

// Words that say what kind of thing it is, not which thing.
const GENERIC = new Set("meeting event night day duty game party session school class family parent parents morning evening afternoon weekly monthly annual check".split(" "));
const distinctive = (t: string) => new Set((t.toLowerCase().match(/[a-z]{5,}/g) || []).filter((w) => !GENERIC.has(w)));
/** A work entry that is this event (the parent put it on their work calendar, e.g. a duty at it). */
function isThisEvent(b: WorkBlock, e: CalEvent, w: { from: Date; to: Date }): boolean {
  if (titlesSimilar(b.title, e.title)) return true;
  const near = +new Date(b.start) < +w.to + 3600000 && +new Date(b.end) > +w.from - 3600000;
  const mine = distinctive(e.title);
  return near && [...distinctive(b.title)].some((x) => mine.has(x));
}

/** The parent put this event on their own work calendar: they've planned for it. */
export function plannedFor(e: CalEvent, blocks: WorkBlock[]): WorkBlock | undefined {
  const w = eventWindow(e);
  return w ? blocks.find((b) => !b.allDay && !b.kimiHold && blockDay(b) === w.day && isThisEvent(b, e, w)) : undefined;
}

/** What on this parent's work day collides with the event. */
export function clashesFor(e: CalEvent, p: Parent, blocks: WorkBlock[]): Clash[] {
  const w = eventWindow(e);
  if (!w) return [];
  const series = !!e.seriesId;
  const k = (kind: string, b?: WorkBlock) => `${p}|${kind}|${b ? (series ? normTitle(b.title) : `${normTitle(b.title)}|${b.start}`) : series ? "" : w.day}`;
  const overlaps = (b: WorkBlock) => +new Date(b.start) < +w.to && +new Date(b.end) > +w.from;
  const day = blocks.filter((b) => (b.allDay ? b.start.slice(0, 10) <= w.day && w.day < b.end.slice(0, 10) : blockDay(b) === w.day));
  // A long, come-when-you-can event (a fundraiser night, an open house): only being away rules it out.
  const long = +w.to - +w.from > (3 * 60 + 2 * (e.travelMin ?? DEFAULT_TRAVEL_MIN)) * 60000;
  const out: Clash[] = [];
  for (const b of day) {
    if (b.kimiHold) continue; // Kimi's own hold for a family event: never a conflict (nor a sign they planned it)
    if (!b.allDay && isThisEvent(b, e, w)) continue; // the event itself, on their work calendar
    if (b.outOfOffice && (b.allDay || overlaps(b))) out.push({ parent: p, kind: "out", key: k("out", b), line: `out of office${b.allDay ? " all day" : ` ${span(b)}`} ("${b.title}")` });
    else if (b.trip && (b.allDay || overlaps(b))) out.push({ parent: p, kind: "trip", key: k("trip", b), line: `traveling: "${b.title}" ${b.allDay ? "all day" : span(b)}` });
    // (An entry Kimi can't place — maybe a hold — isn't a conflict on its own; it shows in the day's context.)
    else if (!long && !b.allDay && !b.hold && !b.unsure && overlaps(b)) out.push({ parent: p, kind: "meeting", key: k("meeting", b), line: `"${b.title}" ${span(b)}${where(b) ? ` (${where(b)})` : ""}` });
  }
  // An office day: from the commute in until the commute home starts (just one commute: only during it —
  // when the day ends isn't known, and the meetings speak for themselves).
  const commutes = day.filter((b) => b.travel && !b.trip && !b.allDay).sort((a, b) => a.start.localeCompare(b.start));
  if (!long && commutes.length && !out.some((c) => c.kind === "out" || c.kind === "trip")) {
    const first = commutes[0], last = commutes[commutes.length - 1];
    const officeFrom = new Date(first.start);
    const officeTo = new Date(commutes.length > 1 ? last.start : first.end);
    if (+officeFrom < +w.to && +officeTo > +w.from) {
      out.push({ parent: p, kind: "office", key: k("office"), line: `an office day (commute "${first.title}" ${span(first)}${commutes.length > 1 ? `, back "${last.title}" ${span(last)}` : ""})` });
    }
  }
  return out;
}

/** The parents the event is for (none named: whoever takes it, so it only clashes when no one can). */
export function responsibleFor(e: CalEvent): { parents: Parent[]; anyOne: boolean } {
  if (e.privateTo && (PARENTS as readonly string[]).includes(e.privateTo)) return { parents: [e.privateTo as Parent], anyOne: false };
  const named = (e.owner || []).filter((o): o is Parent => (PARENTS as readonly string[]).includes(o));
  return named.length ? { parents: named, anyOne: false } : { parents: [...PARENTS] as Parent[], anyOne: true };
}

export interface Flag {
  event: CalEvent;
  /** Who should hear about it (the parents it's for). */
  to: Member[];
  clashes: Clash[];
  /** Context for writing it: each parent's work day, and anyone who already planned for it. */
  context: string;
  /** Its key in the seen-record (the series, for a repeating event). */
  seenId: string;
  /**
   * Why now: the event is new to Kimi; it changed (time, who it's for) since she raised it; or it's
   * unchanged and something new on a work calendar collides with it — a meeting booked by someone
   * who can't see the family calendar.
   */
  why: "new-event" | "changed" | "new-work";
  /** The collisions not raised before (all of them unless why is new-work). */
  fresh: Clash[];
}

const sigOf = (e: CalEvent) => `${e.seriesId ? "" : e.date}|${toHomeZone(e).start || ""}|${toHomeZone(e).end || ""}|${(e.owner || []).join(",")}|${e.privateTo || ""}`;

/**
 * Upcoming family events with a work conflict that hasn't been raised yet. `save()` records what
 * was seen, so the same conflict is never raised twice. `only`: checks.
 */
export async function findConflicts(events: CalEvent[], opts: { only?: string[] } = {}): Promise<{ flags: Flag[]; save: (unsent?: Flag[]) => Promise<void> }> {
  const now = Date.now();
  const until = new Date(now + HORIZON_DAYS * 86400000);
  const upcoming = events.filter((e) => onCalendar(e) && !e.allDay && e.start && (!opts.only || opts.only.includes(e.id)) && (() => { const w = eventWindow(e); return !!w && +w.from > now && +w.from < +until; })());
  if (!upcoming.length) return { flags: [], save: async () => {} };
  const blocks: Partial<Record<Parent, WorkBlock[]>> = {};
  for (const p of PARENTS as readonly Parent[]) blocks[p] = await getWorkBlocks(p, new Date(now), until); // a read error throws: try again next tick
  const seen = ((await redis.hgetall<Record<string, { sig: string; keys: string[] }>>(seenKey)) || {}) as Record<string, { sig: string; keys: string[] }>;
  const flags: Flag[] = [];
  const updates: Record<string, { sig: string; keys: string[] }> = {};
  const doneSeries = new Set<string>();
  for (const e of upcoming.sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")))) {
    const id = e.seriesId ? `series:${e.seriesId}` : e.id;
    if (doneSeries.has(id)) continue;
    const { parents, anyOne } = responsibleFor(e);
    const clashes: Clash[] = [];
    const planned: string[] = [];
    let free = 0;
    for (const p of parents) {
      const mine = blocks[p] || [];
      const pf = plannedFor(e, mine);
      if (pf) { planned.push(`${memberName(p)} already has "${pf.title}" ${span(pf)} on their work calendar`); free++; continue; }
      const c = clashesFor(e, p, mine);
      if (c.length) clashes.push(...c);
      else free++;
    }
    const rec = seen[id];
    const sig = sigOf(e);
    const known = rec && rec.sig === sig ? new Set(rec.keys) : new Set<string>();
    const keys = clashes.map((c) => c.key);
    // A repeating event: the first upcoming occurrence speaks for the series.
    if (e.seriesId) doneSeries.add(id);
    const fresh = clashes.filter((c) => !known.has(c.key));
    updates[id] = { sig, keys: [...new Set([...known, ...keys])] };
    if (!fresh.length) continue;
    if (anyOne && free > 0) continue; // someone can take it
    const w = eventWindow(e)!;
    const context = (PARENTS as readonly Parent[])
      .map((p) => {
        const day = (blocks[p] || []).filter((b) => (b.allDay ? b.start.slice(0, 10) <= w.day && w.day < b.end.slice(0, 10) : blockDay(b) === w.day));
        return `${memberName(p)}'s work calendar that day:\n${day.length ? formatBlocks(day) : "(nothing on it)"}`;
      })
      .concat(planned)
      .join("\n");
    const why = !rec ? "new-event" : rec.sig !== sig ? "changed" : "new-work";
    // New on a work calendar: only the parent whose calendar it is needs to hear about it.
    const to = why === "new-work" ? parents.filter((p) => fresh.some((c) => c.parent === p)) : parents;
    flags.push({ event: e, to, clashes, context, seenId: id, why, fresh });
  }
  /** Record what was seen — except flags that weren't sent (they come up again next time). */
  const save = async (unsent: Flag[] = []) => {
    for (const f of unsent) delete updates[f.seenId];
    if (Object.keys(updates).length) await redis.hset(seenKey, updates);
    // Forget events that are past (or gone).
    const live = new Set(upcoming.map((e) => (e.seriesId ? `series:${e.seriesId}` : e.id)));
    const stale = Object.keys(seen).filter((k) => !live.has(k));
    if (stale.length && !opts.only) await redis.hdel(seenKey, ...stale);
  };
  return { flags, save };
}
