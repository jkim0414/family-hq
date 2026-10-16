import { redis, getCollection } from "./db.js";
import { getCal } from "./calendar.js";
import { localSkip } from "./sandbox.js";
import { getWorkBlocks, getWorkCalConfig, type WorkBlock, type Parent } from "./workcal.js";
import { eventWindow, clashesFor, plannedFor } from "./conflicts.js";
import { onCalendar } from "../../src/data/invites.js";
import { toHomeZone, utcToWall, HOME_TZ, fmt12 } from "../../src/data/tz.js";
import { CONFIG } from "../../src/data/config.js";
import type { CalEvent } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Holds on a parent's work calendar for family events in their working hours ("DNS – Fun
// Run"), so whoever books their meetings works around them. Each is an invitation to the work
// address from its own calendar in the family's Google account (CONFIG.workHolds) — Kimi can't write
// to the work calendar itself. She only ever touches holds she made, and keeps them in step with
// their family event: moved when it moves, removed when it's gone or no longer theirs.
// Theirs means named on it, or a kids' event naming no parent. Not held: repeating events, long come-when-you-can ones, anything that already collides with a
// meeting (that's a conflict text instead), and time they've already blocked themselves.
// ─────────────────────────────────────────────────────────────────────────────

const HORIZON_DAYS = 42;
const LONG_MIN = 3 * 60;
interface HoldRec { gcalId: string; title: string; start: string; end: string }
const holdsKey = (p: Parent) => `workholds:${p}`;
const prefKey = (p: Parent) => `workholds_pref:${p}`;
const newKey = (p: Parent) => `workholds_new:${p}`;

export const holdParents = (): Parent[] => Object.keys(CONFIG.workHolds) as Parent[];

/** "Hold this one" / "don't hold this one" — the parent's word beats the rules. */
export async function setHoldPref(p: Parent, eventId: string, hold: boolean): Promise<void> {
  await redis.hset(prefKey(p), { [eventId]: hold ? "yes" : "no" });
}

const minutes = (hhmm?: string) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : 0);

/** Is this event theirs to hold time for at all (whatever's on the work calendar)? */
export function holdable(e: CalEvent, p: Parent, pref: string | undefined, now = Date.now(), kidIds: string[] = []): boolean {
  if (pref === "no") return false;
  if (!onCalendar(e) || e.allDay || !e.start || e.seriesId) return false;
  if (e.privateTo && e.privateTo !== p) return false;
  if (e.audience && !e.audience.includes(p)) return false;
  // Theirs: they're named on it, or it's the kids' with no parent named (whoever goes — a school parade).
  const forKids = !(e.owner || []).length && (e.people || []).some((x) => kidIds.includes(x));
  if (pref !== "yes" && !(e.owner || []).includes(p) && e.privateTo !== p && !forKids) return false;
  const w = eventWindow(e);
  if (!w || +w.from <= now || +w.from > now + HORIZON_DAYS * 86400000) return false;
  const h = toHomeZone(e);
  if (pref !== "yes" && h.end && minutes(h.end) - minutes(h.start) > LONG_MIN) return false;
  const dow = new Date(`${w.day}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  // In working hours by the event's own time (the drive around it doesn't make a 6 PM dinner a workday thing).
  const [open, close] = CONFIG.workHolds[p].hours;
  return h.start! < close && (h.end || h.start!) > open;
}

/** Should a NEW hold go on now? Not when it already collides (a conflict text covers that) or they've blocked it. */
export function wantsNewHold(e: CalEvent, p: Parent, blocks: WorkBlock[]): boolean {
  if (plannedFor(e, blocks)) return false;
  if (clashesFor(e, p, blocks).some((c) => c.kind !== "office")) return false;
  const w = eventWindow(e)!;
  return !blocks.some((b) => b.hold && !b.kimiHold && !b.travel && !b.trip && !b.allDay && +new Date(b.start) <= +w.from && +new Date(b.end) >= +w.to);
}

export const holdTitle = (e: CalEvent) => `DNS – ${e.title}`.slice(0, 100);

/** Bring each parent's holds in line with the family calendar. Returns what changed. */
export async function syncWorkHolds(events: CalEvent[], opts: { only?: string[] } = {}): Promise<{ placed: string[]; moved: string[]; removed: string[] }> {
  const out = { placed: [] as string[], moved: [] as string[], removed: [] as string[] };
  for (const p of holdParents()) {
    const cfg = await getWorkCalConfig(p);
    const work = cfg?.source === "google" && cfg.id.includes("@") ? cfg.id : null;
    if (!work) continue;
    const calId = CONFIG.workHolds[p].calendarId;
    const [held, prefs] = await Promise.all([
      redis.hgetall<Record<string, HoldRec>>(holdsKey(p)).then((x) => x || {}),
      redis.hgetall<Record<string, string>>(prefKey(p)).then((x) => x || {}),
    ]);
    const now = Date.now();
    const blocks = await getWorkBlocks(p, new Date(now), new Date(now + HORIZON_DAYS * 86400000));
    const byId = new Map(events.map((e) => [e.id, e]));
    const kidIds = (await getCollection("kids")).map((k) => k.id);
    const cal = localSkip("Google Calendar: work holds") ? null : await getCal();
    const body = (e: CalEvent) => {
      const w = eventWindow(e)!;
      return { summary: holdTitle(e), start: { dateTime: w.from.toISOString() }, end: { dateTime: w.to.toISOString() } };
    };
    const changes: Record<string, HoldRec | null> = {};

    // Holds already placed: keep in step, or take down.
    for (const [id, rec] of Object.entries(held)) {
      if (opts.only && !opts.only.includes(id)) continue;
      const e = byId.get(id);
      const w = e && eventWindow(e);
      if (w && +w.from <= now) { if (+w.to < now) changes[id] = null; continue; } // under way: leave it; over: forget it
      if (!e || !holdable(e, p, prefs[id], now, kidIds)) {
        if (cal) await cal.events.delete({ calendarId: calId, eventId: rec.gcalId, sendUpdates: "none" }).catch(() => {});
        changes[id] = null;
        out.removed.push(rec.title);
        continue;
      }
      const b = body(e);
      if (b.summary !== rec.title || b.start.dateTime !== rec.start || b.end.dateTime !== rec.end) {
        if (cal) await cal.events.patch({ calendarId: calId, eventId: rec.gcalId, sendUpdates: "none", requestBody: b }).catch(() => {});
        changes[id] = { gcalId: rec.gcalId, title: b.summary, start: b.start.dateTime, end: b.end.dateTime };
        out.moved.push(b.summary);
      }
    }

    // New ones.
    for (const e of events) {
      if (held[e.id] || (opts.only && !opts.only.includes(e.id))) continue;
      if (!holdable(e, p, prefs[e.id], now, kidIds)) continue;
      if (prefs[e.id] !== "yes" && !wantsNewHold(e, p, blocks)) continue;
      const b = body(e);
      let gcalId = `local-${e.id}`;
      if (cal) {
        const r = await cal.events.insert({
          calendarId: calId,
          sendUpdates: "none",
          requestBody: {
            ...b,
            // Accepted, so it reads as solid busy time, not an unanswered invitation. No email goes out.
            attendees: [{ email: work, responseStatus: "accepted" }],
            guestsCanSeeOtherGuests: false,
            guestsCanInviteOthers: false,
            guestsCanModify: false,
            transparency: "opaque",
            reminders: { useDefault: false, overrides: [] },
            extendedProperties: { private: { kimiHold: e.id } },
          },
        });
        gcalId = r.data.id!;
      }
      changes[e.id] = { gcalId, title: b.summary, start: b.start.dateTime, end: b.end.dateTime };
      const s = utcToWall(new Date(b.start.dateTime), HOME_TZ), en = utcToWall(new Date(b.end.dateTime), HOME_TZ);
      const line = `${b.summary}, ${new Date(`${s.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" })} ${fmt12(s.time)}–${fmt12(en.time)}`;
      out.placed.push(line);
    }

    const sets = Object.fromEntries(Object.entries(changes).filter(([, v]) => v)) as Record<string, HoldRec>;
    const gone = Object.keys(changes).filter((k) => !changes[k]);
    if (Object.keys(sets).length) await redis.hset(holdsKey(p), sets);
    if (gone.length) await redis.hdel(holdsKey(p), ...gone);
    if (out.placed.length) {
      const prev = ((await redis.get<string[]>(newKey(p))) || []).slice(-20);
      await redis.set(newKey(p), [...prev, ...out.placed]);
    }
  }
  return out;
}

/** Holds placed since the last morning text (and clear the list): for its one line about them. */
export async function takeNewHolds(p: Parent): Promise<string[]> {
  const list = (await redis.get<string[]>(newKey(p))) || [];
  if (list.length) await redis.del(newKey(p));
  return list;
}

/** The holds a parent has now, for Kimi to answer "what did you hold?" / remove one. */
export async function listHolds(p: Parent): Promise<(HoldRec & { eventId: string })[]> {
  const held = (await redis.hgetall<Record<string, HoldRec>>(holdsKey(p))) || {};
  return Object.entries(held).map(([eventId, r]) => ({ ...r, eventId })).sort((a, b) => a.start.localeCompare(b.start));
}
