import { localSkip } from "./sandbox.js";
import { google, calendar_v3 } from "googleapis";
import { CONFIG } from "../../src/data/config.js";
import { utcToWall } from "../../src/data/tz.js";
import { htmlToText } from "../../src/data/text.js";
import { extractLinks, type Link } from "./links.js";
import { redis } from "./db.js";
import { seal, unseal, type Sealed } from "./vault.js";
import { titlesSimilar, nextDay, prevDay } from "./util.js";
import type { CalEvent } from "../../src/data/types";

// Google Calendar sync using a stored OAuth refresh token (saved in KV during the
// one-time consent flow, or via env). Returns null/skips gracefully if not configured.
async function getRefreshToken(): Promise<string | null> {
  if (process.env.GOOGLE_REFRESH_TOKEN) return process.env.GOOGLE_REFRESH_TOKEN;
  return unseal(await redis.get<Sealed>("google_refresh_token"));
}

/** Save the family calendar's Google connection (encrypted at rest). */
export async function setCalendarToken(refreshToken: string): Promise<void> {
  await redis.set("google_refresh_token", seal(refreshToken));
}

export async function getCal(): Promise<calendar_v3.Calendar | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = await getRefreshToken();
  if (!clientId || !clientSecret || !refreshToken) return null;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth: oauth2 });
}

function buildBody(evt: CalEvent): calendar_v3.Schema$Event {
  const tz = CONFIG.calendar.timeZone;
  const startTz = evt.startTz || tz;
  const endTz = evt.endTz || startTz;
  const endDate = evt.endDate || evt.date;
  const start = evt.allDay
    ? { date: evt.date }
    : { dateTime: `${evt.date}T${evt.start || "09:00"}:00`, timeZone: startTz };
  // All-day end date is EXCLUSIVE in the Calendar API — day after the last day.
  // endDate supports multi-day all-day spans (school breaks, trips).
  const end = evt.allDay
    ? { date: nextDay(endDate) }
    : { dateTime: `${endDate}T${evt.end || evt.start || "10:00"}:00`, timeZone: endTz };
  return {
    summary: evt.title,
    location: evt.location,
    description: evt.prep || undefined,
    start,
    end,
    attendees: CONFIG.calendar.alwaysInvite.map((email) => ({ email })),
  };
}

export async function createCalendarEvent(
  evt: CalEvent,
  opts?: { silent?: boolean }
): Promise<string | null> {
  if (localSkip("Google Calendar: createCalendarEvent")) return null;
  const cal = await getCal();
  if (!cal) return null;

  // Skip if a similar event already exists that day (dedup against pre-existing / repeats).
  try {
    const sameDay = await cal.events.list({
      calendarId: CONFIG.calendar.targetCalendarId,
      timeMin: `${prevDay(evt.date)}T00:00:00Z`,
      timeMax: `${nextDay(evt.date)}T00:00:00Z`,
      singleEvents: true,
      maxResults: 50,
    });
    const dup = (sameDay.data.items || []).find(
      (e) => (e.start?.dateTime || e.start?.date || "").slice(0, 10) === evt.date && titlesSimilar(e.summary || "", evt.title)
    );
    if (dup) return dup.id ?? null;
  } catch {
    /* fall through and create */
  }

  const res = await cal.events.insert({
    calendarId: CONFIG.calendar.targetCalendarId,
    sendUpdates: opts?.silent ? "none" : "all",
    requestBody: buildBody(evt),
  });
  return res.data.id ?? null;
}

export async function updateCalendarEvent(evt: CalEvent, opts?: { silent?: boolean }): Promise<string | null> {
  if (localSkip("Google Calendar: updateCalendarEvent")) return null;
  const cal = await getCal();
  if (!cal) return null;
  // No gcalId yet → create it now.
  if (!evt.gcalId) return createCalendarEvent(evt, opts);
  try {
    await cal.events.update({
      calendarId: CONFIG.calendar.targetCalendarId,
      eventId: evt.gcalId,
      sendUpdates: opts?.silent ? "none" : "all",
      requestBody: buildBody(evt),
    });
    return evt.gcalId;
  } catch {
    return evt.gcalId;
  }
}

/** True only when Google confirms the event was deleted (cancelled, or gone). Any doubt → false. */
export async function calendarEventGone(gcalId: string): Promise<boolean> {
  const cal = await getCal();
  if (!cal || !gcalId) return false;
  try {
    const r = await cal.events.get({ calendarId: CONFIG.calendar.targetCalendarId, eventId: gcalId });
    return r.data.status === "cancelled";
  } catch (e) {
    const code = (e as { code?: number; status?: number }).code ?? (e as { status?: number }).status;
    return code === 404 || code === 410;
  }
}

// Find events matching a text query within a date range (for calendar commands).
export async function findEvents(
  query: string,
  from: string,
  to: string
): Promise<{ id: string; summary: string; date: string }[]> {
  const cal = await getCal();
  if (!cal) return [];
  // Widen the UTC window by a day each side (avoids TZ-offset edge misses), then
  // filter precisely by local date [from, to) in code.
  const res = await cal.events.list({
    calendarId: CONFIG.calendar.targetCalendarId,
    q: query,
    timeMin: `${prevDay(from)}T00:00:00Z`,
    timeMax: `${nextDay(to)}T00:00:00Z`,
    singleEvents: true,
    maxResults: 250,
    orderBy: "startTime",
  });
  return (res.data.items || [])
    .map((e) => ({
      id: e.id || "",
      summary: e.summary || "",
      date: (e.start?.dateTime || e.start?.date || "").slice(0, 10),
    }))
    .filter(
      (e) =>
        e.id &&
        e.summary.toLowerCase().includes(query.toLowerCase()) &&
        e.date >= from &&
        e.date < to
    );
}

// Patch selected fields of an existing event (move/reschedule or bulk-edit).
export async function patchCalendarEvent(
  gcalId: string,
  set: { date?: string; start?: string; end?: string; location?: string; title?: string }
): Promise<void> {
  if (localSkip("Google Calendar: patchCalendarEvent")) return;
  const cal = await getCal();
  if (!cal) return;
  const tz = CONFIG.calendar.timeZone;
  try {
    const cur = (await cal.events.get({ calendarId: CONFIG.calendar.targetCalendarId, eventId: gcalId })).data;
    const body: calendar_v3.Schema$Event = {};
    if (set.title) body.summary = set.title;
    if (set.location !== undefined) body.location = set.location;

    if (set.date || set.start || set.end) {
      const curDate = (cur.start?.dateTime || cur.start?.date || "").slice(0, 10);
      const curStart = cur.start?.dateTime ? cur.start.dateTime.slice(11, 16) : null;
      const curEnd = cur.end?.dateTime ? cur.end.dateTime.slice(11, 16) : null;
      const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const fromMin = (m: number) =>
        `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const date = set.date || curDate;
      const start = set.start || curStart;
      if (start) {
        // Preserve the original duration when end isn't specified (avoids end<start).
        let end = set.end;
        if (!end) {
          const dur = curStart && curEnd ? Math.max(15, toMin(curEnd) - toMin(curStart)) : 60;
          end = fromMin(toMin(start) + dur);
        }
        body.start = { dateTime: `${date}T${start}:00`, timeZone: tz };
        body.end = { dateTime: `${date}T${end}:00`, timeZone: tz };
      } else {
        body.start = { date };
        body.end = { date: nextDay(date) };
      }
    }
    await cal.events.patch({
      calendarId: CONFIG.calendar.targetCalendarId,
      eventId: gcalId,
      sendUpdates: "none",
      requestBody: body,
    });
  } catch {
    /* best-effort */
  }
}

export async function deleteCalendarEvent(gcalId: string): Promise<void> {
  if (localSkip("Google Calendar: deleteCalendarEvent")) return;
  const cal = await getCal();
  if (!cal) return;
  try {
    await cal.events.delete({
      calendarId: CONFIG.calendar.targetCalendarId,
      eventId: gcalId,
      sendUpdates: "none",
    });
  } catch {
    /* already gone */
  }
}

export interface RawCalendarEvent {
  id: string;
  links?: Link[]; // links in the description (invites, sign-ups) — the text version loses them
  title: string;
  date: string; // YYYY-MM-DD (local start date)
  start?: string; // HH:mm in startTz
  end?: string; // HH:mm in endTz
  endDate?: string; // YYYY-MM-DD if end is on a different day
  startTz?: string;
  endTz?: string;
  allDay: boolean;
  location?: string;
  description?: string;
  eventType?: string;
  recurringEventId?: string; // set when this is an instance of a recurring series
  declined: boolean; // the account itself declined this event
  /** An invitation from someone outside the family that nobody has accepted yet. */
  strangerInvite?: boolean;
  updated: string; // RFC3339 last-modified timestamp (drives edit detection)
}

// Read events from the target (Personal) calendar in a date window, normalized
// to our CalEvent shape. Used by the calendar-import pipeline.
export async function listCalendarEvents(from: string, to: string): Promise<RawCalendarEvent[]> {
  const cal = await getCal();
  if (!cal) return [];
  const tz = CONFIG.calendar.timeZone;
  // Every page: a busy stretch can pass 250 events, and a truncated list would make events look deleted.
  const items: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 8; i++) {
    const res = await cal.events.list({
      calendarId: CONFIG.calendar.targetCalendarId,
      timeMin: `${prevDay(from)}T00:00:00Z`,
      timeMax: `${nextDay(to)}T00:00:00Z`,
      singleEvents: true,
      maxResults: 250,
      orderBy: "startTime",
      pageToken,
    });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return items
    .filter((e) => e.status !== "cancelled")
    .map((e): RawCalendarEvent => {
      const allDay = !e.start?.dateTime;
      const declined = (e.attendees || []).some((a) => a.self && a.responseStatus === "declined");
      // Anyone can put an invitation on a Google Calendar. One from outside the family that no one
      // has accepted is a stranger's text, not the family's plan.
      const family = [CONFIG.calendar.targetCalendarId, CONFIG.parents.alex.email, CONFIG.parents.sam.email, ...CONFIG.calendar.alwaysInvite].map((x) => String(x || "").toLowerCase());
      const organizer = (e.organizer?.email || "").toLowerCase();
      const me = (e.attendees || []).find((a) => a.self);
      const strangerInvite = !!organizer && !e.organizer?.self && !family.includes(organizer) && (!me || me.responseStatus === "needsAction");
      // Timed events: the offset-bearing dateTime is the ONLY trustworthy time.
      // (The API renders dateTime in the response zone while `timeZone` is the
      // event's creation zone — pairing a sliced wall-clock with that field
      // once shifted a 1 PM PT dinner to 4 PM.) Parse the absolute instant and
      // normalize to the home zone.
      let date = (e.start?.date || "").slice(0, 10);
      let start: string | undefined;
      let end: string | undefined;
      let endDate: string | undefined;
      if (allDay) {
        // All-day end is exclusive: a Mon–Fri break ends "Saturday". Without this every multi-day
        // all-day event read back as its first day only (a week-long break filed as just its Monday).
        const last = e.end?.date ? prevDay(e.end.date.slice(0, 10)) : date;
        if (last > date) endDate = last;
      } else {
        const s = utcToWall(new Date(e.start!.dateTime!), tz);
        date = s.date;
        start = s.time;
        if (e.end?.dateTime) {
          const ed = utcToWall(new Date(e.end.dateTime), tz);
          end = ed.time;
          if (ed.date !== date) endDate = ed.date;
        }
      }
      return {
        id: e.id || "",
        title: e.summary || "(untitled)",
        date,
        start,
        end,
        endDate,
        startTz: tz, // normalized to home zone above
        endTz: tz,
        allDay,
        location: e.location || undefined,
        description: htmlToText(e.description) || undefined,
        links: e.description ? extractLinks(e.description, e.description) : [],
        eventType: e.eventType || "default",
        recurringEventId: e.recurringEventId || undefined,
        declined,
        strangerInvite,
        updated: e.updated || "",
      };
    })
    .filter((e) => e.id && e.date >= from && e.date < to);
}
