import { classify, profileContext } from "./classify.js";
import { appendItems, getCollection, getProfile } from "./db.js";
import { createCalendarEvent, updateCalendarEvent } from "./calendar.js";
import { eventsSimilar, commsDuplicate, mergeEventDetails, todosSimilar, adjustPrepDue } from "./util.js";
import { CONFIG } from "../../src/data/config.js";

const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.calendar.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
import { applyMetadata } from "./metadata.js";
import { sendEmail } from "./email.js";
import type { RawMessage } from "./imap.js";
import { extractLinks, fetchLinkedPages } from "./links.js";
import { completePartyPrep } from "./conventions.js";
import { closeIfAlreadyDone } from "./verify.js";
import type { CalEvent, Comm, Todo } from "../../src/data/types";

// The "file an email" pipeline, shared by the forwarding inbox and the watched
// parent inboxes: classify → dedupe → events / to-dos / comm record → metadata
// → Google Calendar → alert email. Callers decide which messages to pass and
// mark them seen afterwards using the returned keys.

export interface FileInput extends RawMessage {
  /** Stable id for this message across runs (used in comm/event/todo ids). */
  key: string;
  mailbox: "school" | "alex" | "sam";
}

export interface FileStats {
  filed: number;
  events: number;
  updatedEvents: number;
  todos: number;
  alerts: number;
  duplicates: number;
  metaApplied: number;
  metaSuggested: number;
  processedKeys: string[];
}

const MAILBOX_LABEL = { school: "Forwarded to the school inbox", alex: "Alex's own Gmail (watched)", sam: "Sam's own Gmail (watched)" };

export async function fileMessages(messages: FileInput[], opts: { quiet?: boolean } = {}): Promise<FileStats> {
  const stats: FileStats = { filed: 0, events: 0, updatedEvents: 0, todos: 0, alerts: 0, duplicates: 0, metaApplied: 0, metaSuggested: 0, processedKeys: [] };
  if (!messages.length) return stats;

  // Private items (a parent's Just-me chat) are never matched, shown to the classifier, or updated by filing.
  const existingEvents = (await getCollection("events")).filter((e) => !e.privateTo);
  const existingComms = await getCollection("comms");
  const existingTodos = (await getCollection("todos")).filter((t) => !t.privateTo);
  const profileCtx = profileContext(await getProfile());
  const newComms: Comm[] = [];
  const newEvents: CalEvent[] = [];
  const updatedEvents: CalEvent[] = [];
  const newTodos: Todo[] = [];
  const alerts: { title: string; summary: string }[] = [];
  const today = todayLocal();

  // What's already on the books, so the model can recognise "the same thing
  // again" (a digest, a reminder, a calendar entry) instead of re-creating it.
  const knownCtx = () => {
    const evs = [...existingEvents, ...newEvents]
      .filter((e) => e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 80)
      .map((e) => `${e.id} | ${e.date} ${e.allDay ? "all-day" : e.start || ""} | ${e.title}${e.location ? ` @ ${e.location}` : ""}`);
    const tds = [...existingTodos, ...newTodos]
      .filter((t) => !t.done)
      .slice(0, 60)
      .map((t) => `${t.id} | due ${t.due || "—"} | ${t.title}`);
    return [evs.length ? "EXISTING EVENTS (id | date time | title @ location):\n" + evs.join("\n") : "", tds.length ? "OPEN TO-DOS (id | due | title):\n" + tds.join("\n") : ""].filter(Boolean).join("\n\n");
  };

  for (const m of messages) {
    // Details are often behind a link ("RSVP here", a Google Doc, an Evite) —
    // follow the promising ones and give the classifier the page text too.
    const linked = await fetchLinkedPages(m.links ?? extractLinks(m.text)).catch(() => "");
    const c = await classify({
      from: m.from,
      subject: m.subject,
      text: linked ? `${m.text}\n\n${linked}` : m.text,
      receivedAt: m.date,
      attachments: m.attachments,
      context: `${profileCtx}\n\nArrived via: ${MAILBOX_LABEL[m.mailbox]}.\n\n${knownCtx()}`,
    });
    completePartyPrep(c, `${m.subject}\n${m.text}\n${linked}`);

    // Same communication received twice (both parents get the school blast,
    // or one of them also forwarded it)? File it once.
    const descriptor = { receivedAt: m.date, people: c.people, subject: c.subject || m.subject, summary: c.summary };
    if ([...existingComms, ...newComms].some((ec) => commsDuplicate(descriptor, ec))) {
      stats.duplicates++;
      stats.processedKeys.push(m.key);
      continue;
    }

    const commId = `comm-${m.key}`;
    const eventIds: string[] = [];
    const todoIds: string[] = [];

    // "This is about an event you already have" — link it, apply any corrections.
    for (const u of c.updates || []) {
      const target = existingEvents.find((e) => e.id === u.id) || newEvents.find((e) => e.id === u.id);
      if (!target) continue;
      const set = u.set || {};
      if (set.title) target.title = set.title;
      if (set.date) target.date = set.date;
      if (set.start !== undefined) target.start = set.start;
      if (set.end !== undefined) target.end = set.end;
      if (set.location !== undefined) target.location = set.location;
      if (set.prep !== undefined) target.prep = set.prep;
      eventIds.push(target.id);
      if (existingEvents.includes(target) && Object.keys(set).length && !updatedEvents.includes(target)) updatedEvents.push(target);
    }

    c.events.forEach((e, i) => {
      const candidate: CalEvent = {
        id: `evt-${m.key}-${i}`,
        title: e.title,
        date: e.date,
        start: e.start,
        end: e.end,
        endDate: e.endDate,
        startTz: e.startTz,
        endTz: e.endTz,
        allDay: e.allDay,
        people: c.people,
        owner: c.owner,
        location: e.location,
        prep: e.prep,
        source: c.source,
        commId,
      };
      // A similar event already on the calendar → update it in place.
      const match = existingEvents.find((ex) => eventsSimilar(ex, candidate)) || newEvents.find((ex) => eventsSimilar(ex, candidate));
      if (match) {
        mergeEventDetails(match, candidate);
        eventIds.push(match.id);
        if (existingEvents.includes(match) && !updatedEvents.includes(match)) updatedEvents.push(match);
        return;
      }
      eventIds.push(candidate.id);
      newEvents.push(candidate);
    });

    // Dates of the events this message is about: prep to-dos must land before them.
    const eventDates = [...existingEvents, ...newEvents].filter((e) => eventIds.includes(e.id)).map((e) => e.date);
    c.todos.forEach((t, i) => {
      const ownerSrc = Array.isArray(t.owner) && t.owner.length ? t.owner : c.owner;
      const todo: Todo = adjustPrepDue(
        {
          id: `todo-${m.key}-${i}`,
          title: t.title,
          detail: t.detail,
          due: t.due,
          people: Array.isArray(t.people) && t.people.length ? t.people : c.people,
          owner: ownerSrc.length ? ownerSrc : ["alex", "sam"],
          priority: t.priority,
          done: false,
          source: c.source,
          commId,
        },
        eventDates
      );
      // Same task already open (from another email or a calendar entry) → link, don't duplicate.
      const dup = [...existingTodos, ...newTodos].find((x) => !x.done && todosSimilar(x, todo));
      if (dup) {
        todoIds.push(dup.id);
        return;
      }
      todoIds.push(todo.id);
      newTodos.push(todo);
    });
    // Before showing an RSVP / sign-up as open, look for proof it's already done.
    await closeIfAlreadyDone(newTodos.filter((t) => t.commId === commId), linked);

    newComms.push({
      id: commId,
      receivedAt: m.date,
      source: c.source,
      people: c.people,
      owner: c.owner,
      category: c.category,
      subject: c.subject || m.subject,
      summary: c.summary,
      reason: c.reason,
      raw: m.text,
      mailbox: m.mailbox,
      eventIds,
      todoIds,
    });
    if (c.category === "alert") alerts.push({ title: c.subject || m.subject, summary: c.summary });

    try {
      const md = await applyMetadata(c.metadata, commId, m.date);
      stats.metaApplied += md.applied;
      stats.metaSuggested += md.suggested;
    } catch (e) {
      console.error("metadata apply failed", e);
    }
    stats.processedKeys.push(m.key);
  }

  for (const evt of newEvents) {
    try {
      const gcalId = await createCalendarEvent(evt, { silent: opts.quiet });
      if (gcalId) evt.gcalId = gcalId;
    } catch (e) {
      console.error("calendar insert failed", evt.id, e);
    }
  }
  for (const evt of updatedEvents) {
    try {
      const gcalId = await updateCalendarEvent(evt);
      if (gcalId) evt.gcalId = gcalId;
    } catch (e) {
      console.error("calendar update failed", evt.id, e);
    }
  }

  if (newComms.length) await appendItems("comms", newComms);
  if (newEvents.length || updatedEvents.length) await appendItems("events", [...newEvents, ...updatedEvents]);
  if (newTodos.length) await appendItems("todos", newTodos);

  if (alerts.length && !opts.quiet) {
    const html = `<h2>⚠️ Action needed</h2><ul>${alerts.map((a) => `<li><b>${a.title}</b><br>${a.summary}</li>`).join("")}</ul><p><a href="https://your-app.vercel.app">Open the hub →</a></p>`;
    await sendEmail(`⚠️ Family HQ: ${alerts.length} item${alerts.length > 1 ? "s" : ""} need attention`, html).catch((e) => console.error("alert email failed", e));
  }

  stats.filed = newComms.length;
  stats.events = newEvents.length;
  stats.updatedEvents = updatedEvents.length;
  stats.todos = newTodos.length;
  stats.alerts = alerts.length;
  return stats;
}
