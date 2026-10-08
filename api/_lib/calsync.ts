import { listCalendarEvents, calendarEventGone } from "./calendar.js";
import { toHomeZone } from "../../src/data/tz.js";
import { classify, profileContext } from "./classify.js";
import { appendItems, getCollection, setCollection, getProfile, getCalVersions, setCalVersions, removeItems } from "./db.js";
import { CONFIG } from "../../src/data/config.js";
import { canSee, onSharedCalendar } from "./privacy.js";
import { todosSimilar, adjustPrepDue } from "./util.js";
import { completePartyPrep } from "./conventions.js";
import { fetchLinkedPages } from "./links.js";
import { closeIfAlreadyDone } from "./verify.js";
import type { CalEvent, Comm, Todo } from "../../src/data/types";

// How far ahead to mirror the Personal calendar, and how many NEW events to
// process per run (bounds classify cost; the rest drain on later runs).
const DAYS_AHEAD = 60;
const MAX_NEW_PER_RUN = 10;

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.calendar.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface CalSyncResult {
  scanned: number;
  imported: number;
  updated: number; // mirrors refreshed because the GCal event was edited
  removed?: number; // events deleted from Google Calendar, removed from the app too
  todos: number;
  skipped: number;
  preview?: { title: string; date: string; people: string[]; todos: string[]; action: string }[];
}

/**
 * Read upcoming events from the Personal calendar that the app DIDN'T create,
 * mirror them into the store (re-using their existing gcalId so we never re-add
 * them to Google Calendar), and run EA-style to-do inference on each.
 *
 * Edit-tracking is ONE-WAY (Google Calendar → app): we record each event's
 * `updated` timestamp, and when it changes we refresh the mirror's fields in
 * place (title/date/time/location/notes). To-dos are not re-inferred on edit.
 * Idempotent: an unchanged event (same `updated`) is skipped.
 */
export async function importCalendarEvents(opts?: { dryRun?: boolean }): Promise<CalSyncResult> {
  const dryRun = opts?.dryRun === true;
  const result: CalSyncResult = { scanned: 0, imported: 0, updated: 0, todos: 0, skipped: 0, preview: [] };
  if (!CONFIG.calendar.importPersonal) return result;

  const from = todayLocal();
  const to = addDays(from, DAYS_AHEAD);
  const raw = await listCalendarEvents(from, to);
  result.scanned = raw.length;
  if (!raw.length) return result;

  // Private and chat-kept items (a Just-me chat, a chat with Grandma) are never matched, shown to the classifier, or updated by filing.
  const existingEvents = (await getCollection("events")).filter((e) => canSee(e, "family"));
  // App-created events (via email/capture) — never mirror these.
  const mirrorsByGcal = new Map(
    existingEvents.filter((e) => e.source === "calendar" && e.gcalId).map((e) => [e.gcalId as string, e])
  );
  const appGcalIds = new Set(existingEvents.map((e) => e.gcalId).filter(Boolean) as string[]);
  const versions = await getCalVersions();

  const profileCtx = profileContext(await getProfile().then((p) => ({ ...p, facts: p.facts.filter((f) => canSee(f, "family")) })));
  const ctx = `Reference dates: today is ${from} (timezone ${CONFIG.calendar.timeZone}).\n${profileCtx}`;

  const newEvents: CalEvent[] = [];
  const newTodos: Todo[] = [];
  const existingTodos = (await getCollection("todos")).filter((t) => canSee(t, "family"));
  const newComms: Comm[] = [];
  const changedMirrors: CalEvent[] = [];
  const verUpdates: Record<string, string> = {};

  for (const ev of raw) {
    // Unchanged since we last saw it → nothing to do.
    if (versions[ev.id] && versions[ev.id] === ev.updated) continue;

    const mirror = mirrorsByGcal.get(ev.id);

    // An event the app put on Google Calendar that a parent then edited there: the edit wins —
    // take its title, time, and place (the app's own notes, people, and owners stay). Without
    // this the app kept the old version and the next filing made a duplicate.
    const appOwned = appGcalIds.has(ev.id) && !mirror ? existingEvents.find((e) => e.gcalId === ev.id) : undefined;
    if (appOwned && versions[ev.id] && !ev.recurringEventId) {
      // Compared as home-zone times: a flight stored in Eastern time isn't "edited" just because
      // Google reports it in Pacific.
      const h = (x: { date: string; start?: string; end?: string; endDate?: string; allDay?: boolean; startTz?: string; endTz?: string }) => { const z = toHomeZone({ ...x, allDay: !!x.allDay }); return [z.date, z.start || "", z.end || "", x.endDate || ""]; };
      const before = JSON.stringify([appOwned.title, ...h(appOwned), appOwned.location || ""]);
      const after = JSON.stringify([ev.title, ...h(ev), ev.location || ""]);
      if (before !== after) {
        Object.assign(appOwned, { title: ev.title, date: ev.date, start: ev.start, end: ev.end, endDate: ev.endDate, startTz: ev.startTz, endTz: ev.endTz, allDay: ev.allDay, location: ev.location });
        changedMirrors.push(appOwned);
        result.updated++;
        result.preview!.push({ title: ev.title, date: ev.date, people: appOwned.people || [], todos: [], action: "updated (edited in Google Calendar)" });
      }
      verUpdates[ev.id] = ev.updated;
      continue;
    }

    // Skip (record version, no mirror): app-created events that aren't mirrors, declined,
    // unanswered invitations from outside the family (picked up once accepted: that changes
    // `updated`), non-default types, or recurring-series instances (routine noise).
    if ((appGcalIds.has(ev.id) && !mirror) || ev.declined || (ev.strangerInvite && !mirror) || ev.eventType !== "default" || ev.recurringEventId) {
      verUpdates[ev.id] = ev.updated;
      result.skipped++;
      continue;
    }

    // Already mirrored and the GCal event changed → refresh fields in place.
    if (mirror) {
      mirror.title = ev.title;
      mirror.date = ev.date;
      mirror.start = ev.start;
      mirror.end = ev.end;
      mirror.endDate = ev.endDate;
      mirror.startTz = ev.startTz;
      mirror.endTz = ev.endTz;
      mirror.allDay = ev.allDay;
      mirror.location = ev.location;
      mirror.prep = ev.description;
      changedMirrors.push(mirror);
      verUpdates[ev.id] = ev.updated;
      result.updated++;
      result.preview!.push({ title: ev.title, date: ev.date, people: mirror.people || [], todos: [], action: "updated" });
      continue;
    }

    // New event → throttle expensive classify; leave unversioned so it's picked
    // up on a later run.
    if (result.imported >= MAX_NEW_PER_RUN) continue;

    let c;
    let linked = "";
    try {
      // The details (and whether we already RSVP'd) often live behind the invite link.
      linked = ev.links?.length ? await fetchLinkedPages(ev.links).catch(() => "") : "";
      const when = ev.allDay ? `${ev.date} (all day)` : `${ev.date} at ${ev.start || "?"}`;
      const text =
        `This event is ALREADY on our family Personal calendar (do NOT create a calendar event for it). ` +
        `Infer any associated to-dos an executive assistant would add, and identify who it is for and who is responsible.\n\n` +
        `Event: "${ev.title}"\nWhen: ${when}\n` +
        (ev.location ? `Where: ${ev.location}\n` : "") +
        (ev.description ? `Details: ${ev.description}\n` : "") +
        (linked ? `\n${linked}\n` : "");
      c = await classify({ from: "Google Calendar (Personal, mirrored)", text, subject: ev.title, receivedAt: `${ev.date}T12:00:00`, context: ctx });
      completePartyPrep(c, text, [{ title: ev.title, date: ev.date }]);
    } catch (e) {
      console.error("calsync classify failed", ev.id, e);
      continue; // leave unversioned → retry next run
    }

    const commId = `comm-cal-${ev.id}`;
    const eventId = `evt-cal-${ev.id}`;
    const todoIds: string[] = [];

    c.todos.forEach((t, i) => {
      const ownerSrc = Array.isArray(t.owner) && t.owner.length ? t.owner : c.owner;
      // Prep for the event can't be due on the event day; and the same task
      // may already exist from an email about the same thing.
      const todo: Todo = adjustPrepDue(
        {
          id: `todo-cal-${ev.id}-${i}`,
          title: t.title,
          detail: t.detail,
          due: t.due,
          people: Array.isArray(t.people) && t.people.length ? t.people : c.people,
          owner: ownerSrc.length ? ownerSrc : ["alex", "sam"],
          priority: t.priority,
          done: false,
          source: "calendar",
          commId,
        },
        [ev.date]
      );
      const dup = [...existingTodos, ...newTodos].find((x) => !x.done && todosSimilar(x, todo));
      if (dup) {
        todoIds.push(dup.id);
        return;
      }
      todoIds.push(todo.id);
      newTodos.push(todo);
    });
    await closeIfAlreadyDone(newTodos.filter((t) => t.commId === commId), linked);

    newEvents.push({
      id: eventId,
      title: ev.title,
      date: ev.date,
      start: ev.start,
      end: ev.end,
      endDate: ev.endDate,
      startTz: ev.startTz,
      endTz: ev.endTz,
      allDay: ev.allDay,
      people: c.people,
      owner: c.owner,
      location: ev.location,
      prep: ev.description,
      source: "calendar",
      commId,
      gcalId: ev.id, // existing GCal event — re-linked, never re-created
    });

    newComms.push({
      id: commId,
      receivedAt: `${ev.date}T12:00:00`,
      source: "calendar",
      people: c.people,
      owner: c.owner,
      category: c.category === "fyi" ? "calendar" : c.category,
      subject: ev.title,
      summary: c.summary || ev.title,
      reason: "Imported from Personal calendar.",
      eventIds: [eventId],
      todoIds,
    });

    verUpdates[ev.id] = ev.updated;
    result.imported++;
    result.todos += todoIds.length;
    result.preview!.push({
      title: ev.title,
      date: ev.date,
      people: c.people || [],
      todos: c.todos.map((t) => t.title),
      action: "import",
    });
  }

  // Deleted in Google Calendar → gone from the app too. Only events on the calendar (they have a
  // gcalId) that fall inside the window just read, and only once Google confirms the deletion.
  const seen = new Set(raw.map((r) => r.id));
  const missing = existingEvents
    .filter((e) => e.gcalId && !seen.has(e.gcalId) && e.date > from && e.date < to)
    .slice(0, 15);
  const gone: string[] = [];
  for (const e of missing) if (await calendarEventGone(e.gcalId!)) gone.push(e.id);
  result.removed = gone.length;
  for (const id of gone) {
    const e = existingEvents.find((x) => x.id === id)!;
    result.preview!.push({ title: e.title, date: e.date, people: e.people || [], todos: [], action: "removed (deleted in Google Calendar)" });
  }

  if (dryRun) return result;

  if (gone.length) {
    await removeItems("events", gone);
    // The prep to-dos inferred from a mirrored event go with it (todo-cal-<gcal id>-n), unless done.
    const prefixes = gone.filter((id) => id.startsWith("evt-cal-")).map((id) => `todo-cal-${id.slice("evt-cal-".length)}-`);
    if (prefixes.length) {
      const todos = await getCollection("todos");
      const drop = todos.filter((t) => !t.done && prefixes.some((p) => t.id.startsWith(p))).map((t) => t.id);
      if (drop.length) await removeItems("todos", drop);
    }
  }
  const eventWrites = [...newEvents, ...changedMirrors];
  if (eventWrites.length) await appendItems("events", eventWrites);
  if (newTodos.length) await appendItems("todos", newTodos);
  if (newComms.length) await appendItems("comms", newComms);
  await setCalVersions(verUpdates);
  return result;
}
