import { classify, profileContext, verifyExtraction } from "./classify.js";
import { appendItems, getCollection, getProfile, setCollection } from "./db.js";
import { createCalendarEvent, updateCalendarEvent, findEvents } from "./calendar.js";
import { eventsSimilar, commsDuplicate, mergeEventDetails, todosSimilar, adjustPrepDue } from "./util.js";
import { applyMetadata } from "./metadata.js";
import { extractLinks, fetchLinkedPages } from "./links.js";
import { completePartyPrep } from "./conventions.js";
import { closeIfAlreadyDone } from "./verify.js";
import { CONFIG } from "../../src/data/config.js";
import type { CalEvent, Comm, Todo, Suggestion } from "../../src/data/types";

// The "file this" pipeline: classify a note / photo / PDF the same way as a
// forwarded email and file it (events, to-dos, comm record, metadata), with
// reconciliation against what's already on the calendar. Used by the chat
// composer for anything with an attachment.

export interface CaptureInput {
  text: string;
  images?: { mediaType?: string; data: string }[];
  /** Suppress calendar guest invites (verification tests must not email Sam). */
  silent?: boolean;
}

export interface CaptureResult {
  ok: true;
  command?: boolean;
  count?: number;
  description?: string;
  duplicate?: boolean;
  category?: string;
  summary?: string;
  people?: string[];
  events?: number;
  updated?: number;
  deletesQueued?: number;
  todos?: number;
  metaApplied?: number;
  metaSuggested?: number;
}

// Local (Pacific) calendar date — server runs in UTC, so slicing toISOString()
// would roll to the next day in the evening.
function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.calendar.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// First Friday on/after a date (YYYY-MM-DD).
function firstFridayOnOrAfter(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** One line a person can read: what filing this did. */
export function describeCapture(r: CaptureResult): string {
  if (r.command) {
    return r.count
      ? `Found ${r.count} matching event${r.count > 1 ? "s" : ""} for “${r.description}”. Confirm the change under Needs you on Home.`
      : `No calendar events matched “${r.description}”.`;
  }
  const n = (k: number | undefined, one: string, many = one + "s") => (k ? `${k} ${k > 1 ? many : one}` : "");
  const parts = [n(r.events, "event added", "events added"), n(r.updated, "event corrected", "events corrected"), n(r.todos, "to-do added", "to-dos added")].filter(Boolean);
  if (r.deletesQueued) parts.push(`${r.deletesQueued} deletion${r.deletesQueued > 1 ? "s" : ""} to confirm on Home`);
  if (r.duplicate) return `Already had that one — skipped.${parts.length ? " " + parts.join(" · ") + "." : ""}`;
  const cat = r.category ? { alert: "Alert", action: "Action", calendar: "Calendar", fyi: "FYI" }[r.category] || r.category : "";
  return `Filed${cat ? ` as ${cat}` : ""}${r.summary ? `: ${r.summary}` : ""}${parts.length ? "\n" + parts.join(" · ") : ""}`;
}

export async function runCapture(input: CaptureInput): Promise<CaptureResult> {
  const text = (input.text || "").trim();
  const images = Array.isArray(input.images) ? input.images : [];
  const silent = input.silent === true;
  if (!text && images.length === 0) throw new Error("text or attachment required");

  // Attachments may be images or PDFs (e.g. a schedule of dates/times);
  // route each to the right content-block kind for the classifier.
  const attachments = images
    .slice(0, 4)
    .filter((im) => im && im.data)
    .map((im) =>
      (im.mediaType || "") === "application/pdf"
        ? { kind: "pdf" as const, mediaType: "application/pdf", data: im.data }
        : { kind: "image" as const, mediaType: im.mediaType || "image/jpeg", data: im.data }
    );

  const now = new Date().toISOString();
  const today = todayLocal();

  // Private items (a parent's Just-me chat) are never matched, shown to the classifier, or updated by filing.
  const [existingEvents, existingComms, existingSuggestions, existingTodos] = await Promise.all([
    getCollection("events").then((xs) => xs.filter((e) => !e.privateTo)),
    getCollection("comms"),
    getCollection("suggestions"),
    getCollection("todos").then((xs) => xs.filter((t) => !t.privateTo)),
  ]);

  // Reference dates so the model can resolve "start of school year" / "first Friday".
  const schoolStart = existingEvents
    .filter((e) => /first day of school/i.test(e.title) && e.date >= today)
    .map((e) => e.date)
    .sort()[0];
  const refDates = `Reference dates: today=${today}${
    schoolStart ? `; school year starts ${schoolStart}; first Friday of school year ${firstFridayOnOrAfter(schoolStart)}` : ""
  }.`;

  // Upcoming events as context so an authoritative input (official schedule,
  // correction notice) can be RECONCILED against what's already filed —
  // emitting updates/deletes by id instead of piling on duplicates.
  const upcoming = existingEvents
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 100);
  const eventsCtx = upcoming.length
    ? "EXISTING EVENTS (id | date time | title @ location):\n" +
      upcoming
        .map((e) => `${e.id} | ${e.date} ${e.allDay ? "all-day" : e.start || ""} | ${e.title}${e.location ? ` @ ${e.location}` : ""}`)
        .join("\n")
    : "";
  const openTodos = existingTodos.filter((t) => !t.done).slice(0, 60);
  const todosCtx = openTodos.length ? "OPEN TO-DOS (id | due | title):\n" + openTodos.map((t) => `${t.id} | due ${t.due || "—"} | ${t.title}`).join("\n") : "";
  const context = [refDates, profileContext(await getProfile()), eventsCtx, todosCtx].filter(Boolean).join("\n\n");

  const linked = text ? await fetchLinkedPages(extractLinks(text)).catch(() => "") : "";
  const c = await classify({
    from: "Quick add (in app)",
    subject: "Quick note",
    text: (text || "(see attached image)") + (linked ? `\n\n${linked}` : ""),
    receivedAt: `${today}T12:00:00`, // anchor relative dates to the local day
    attachments,
    context,
  });
  completePartyPrep(c, `${text}\n${linked}`);

  // Document extractions get an independent verification pass: every proposed
  // add/update/delete is re-checked against the source rows (catches wrong-
  // division rows, invented games, and deletions of rows that exist).
  if (attachments.some((a) => a.kind === "pdf") && c.events.length + c.updates.length + c.deletes.length > 0) {
    const items: string[] = [];
    const tags: { kind: "e" | "u" | "d"; i: number }[] = [];
    c.events.forEach((e, i) => {
      items.push(`ADD event: ${e.date} ${e.start || "all-day"} "${e.title}"${e.location ? ` @ ${e.location}` : ""}`);
      tags.push({ kind: "e", i });
    });
    c.updates.forEach((u, i) => {
      const ex = existingEvents.find((x) => x.id === u.id);
      items.push(`UPDATE existing event "${ex?.title || u.id}" (${ex?.date || "?"}) with ${JSON.stringify(u.set)}`);
      tags.push({ kind: "u", i });
    });
    c.deletes.forEach((d, i) => {
      const ex = existingEvents.find((x) => x.id === d.id);
      items.push(`DELETE existing event "${ex?.title || d.id}" (${ex?.date || "?"}) — ${d.reason}`);
      tags.push({ kind: "d", i });
    });
    try {
      const keep = await verifyExtraction({ attachments, instructions: text || "(none)", items });
      const keepE = new Set<number>(), keepU = new Set<number>(), keepD = new Set<number>();
      tags.forEach((t, j) => {
        if (keep.has(j)) (t.kind === "e" ? keepE : t.kind === "u" ? keepU : keepD).add(t.i);
      });
      c.events = c.events.filter((_, i) => keepE.has(i));
      c.updates = c.updates.filter((_, i) => keepU.has(i));
      c.deletes = c.deletes.filter((_, i) => keepD.has(i));
    } catch (e) {
      // Verification is best-effort for adds/updates, but deletions are
      // destructive — without a verifier verdict, don't propose them.
      console.error("verify pass failed; dropping deletes", e);
      c.deletes = [];
    }
  }

  // Calendar command (delete / move / bulk-edit matching events) → preview + confirm.
  if (c.command && (c.command.action === "delete_events" || c.command.action === "edit_events")) {
    const cmd = c.command;
    const matches = await findEvents(cmd.query, cmd.from, cmd.to);
    if (matches.length) {
      const ids = matches.map((m) => m.id);
      const op =
        cmd.action === "edit_events"
          ? ({ kind: "edit_events", eventIds: ids, set: cmd.set || {} } as const)
          : ({ kind: "delete_events", eventIds: ids } as const);
      const sug: Suggestion = {
        id: `sug-cmd-${Date.now().toString(36)}`,
        description: `${cmd.description} (${matches.length} event${matches.length > 1 ? "s" : ""})`,
        op,
        createdAt: now,
      };
      await setCollection("suggestions", [...existingSuggestions, sug]);
    }
    return { ok: true, command: true, count: matches.length, description: cmd.description };
  }

  const base = `cap-${Date.now().toString(36)}`;
  const commId = `comm-${base}`;
  const newEvents: CalEvent[] = [];
  const updatedEvents: CalEvent[] = [];
  const newTodos: Todo[] = [];
  const eventIds: string[] = [];
  const todoIds: string[] = [];

  // Reconciliation corrections to existing events — applied first so the
  // new-event dedup below compares against the corrected versions.
  for (const u of c.updates) {
    const target = existingEvents.find((e) => e.id === u.id);
    if (!target || !u.set) continue;
    const { title, date, start, end, location, prep } = u.set;
    if (title) target.title = title;
    if (date) target.date = date;
    if (start !== undefined) target.start = start;
    if (end !== undefined) target.end = end;
    if (location !== undefined) target.location = location;
    if (prep !== undefined) target.prep = prep;
    if (!updatedEvents.includes(target)) updatedEvents.push(target);
    eventIds.push(target.id);
  }

  // Reconciliation deletions are destructive → queue ONE preview→confirm
  // suggestion (same flow as calendar commands) rather than auto-deleting.
  // Called AFTER updates/event-matching so a contradictory model output
  // (updating an event and deleting it in the same pass) resolves to the
  // update — never delete an event this same run touched.
  let deletesQueued = 0;
  const queueDeletes = async (touchedIds: string[]) => {
    const touched = new Set(touchedIds);
    const delTargets = c.deletes
      .map((d) => existingEvents.find((e) => e.id === d.id))
      .filter((e): e is CalEvent => !!e && !touched.has(e.id));
    if (!delTargets.length) return;
    const sug: Suggestion = {
      id: `sug-rec-${base}`,
      description: `Remove ${delTargets.length} event${delTargets.length > 1 ? "s" : ""} not on the new schedule: ${delTargets
        .map((e) => `“${e.title}” ${e.date}`)
        .join("; ")}`,
      op: {
        kind: "delete_events",
        eventIds: delTargets.map((e) => e.gcalId).filter(Boolean) as string[],
        storeIds: delTargets.map((e) => e.id),
      },
      createdAt: now,
      commId,
    };
    await setCollection("suggestions", [...existingSuggestions, sug]);
    deletesQueued = delTargets.length;
  };

  // Same comm forwarded/uploaded twice → don't re-file it (and don't re-spawn
  // its events/todos), but DO keep any reconcile corrections made above: a
  // re-sent corrected schedule must still correct the calendar.
  const descriptor = { receivedAt: now, people: c.people, subject: c.subject || text.slice(0, 60), summary: c.summary };
  if (existingComms.some((ec) => commsDuplicate(descriptor, ec))) {
    await queueDeletes(eventIds);
    for (const evt of updatedEvents) {
      try {
        const gcalId = await updateCalendarEvent(evt, { silent: true });
        if (gcalId) evt.gcalId = gcalId;
      } catch (e) {
        console.error("calendar update failed", e);
      }
    }
    if (updatedEvents.length) await appendItems("events", updatedEvents);
    return { ok: true, duplicate: true, summary: c.summary, updated: updatedEvents.length, deletesQueued };
  }

  c.events.forEach((e, i) => {
    const candidate: CalEvent = {
      id: `evt-${base}-${i}`,
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
    // Update an existing similar event in place instead of duplicating.
    const match =
      existingEvents.find((ex) => eventsSimilar(ex, candidate)) ||
      newEvents.find((ex) => eventsSimilar(ex, candidate));
    if (match) {
      mergeEventDetails(match, candidate);
      eventIds.push(match.id);
      if (existingEvents.includes(match) && !updatedEvents.includes(match)) updatedEvents.push(match);
      return;
    }
    eventIds.push(candidate.id);
    newEvents.push(candidate);
  });

  // Deletions queue last: by now eventIds holds every event this run created,
  // corrected, or matched — none of those may be deleted.
  await queueDeletes(eventIds);

  const eventDates = [...existingEvents, ...newEvents].filter((e) => eventIds.includes(e.id)).map((e) => e.date);
  c.todos.forEach((t, i) => {
    // A to-do is by definition an action someone must DO, so it must have an owner.
    // Prefer a per-todo override, else the item-level owner, else default to both parents.
    const ownerSrc = Array.isArray(t.owner) && t.owner.length ? t.owner : c.owner;
    const owner = ownerSrc.length ? ownerSrc : ["alex", "sam"];
    const people = Array.isArray(t.people) && t.people.length ? t.people : c.people;
    const todo: Todo = adjustPrepDue({ id: `todo-${base}-${i}`, title: t.title, detail: t.detail, due: t.due, people, owner, priority: t.priority, done: false, source: c.source, commId }, eventDates);
    const dup = [...existingTodos, ...newTodos].find((x) => !x.done && todosSimilar(x, todo));
    if (dup) {
      todoIds.push(dup.id);
      return;
    }
    todoIds.push(todo.id);
    newTodos.push(todo);
  });
  await closeIfAlreadyDone(newTodos, linked);

  for (const evt of newEvents) {
    try {
      const gcalId = await createCalendarEvent(evt, { silent });
      if (gcalId) evt.gcalId = gcalId;
    } catch (e) {
      console.error("calendar insert failed", e);
    }
  }
  for (const evt of updatedEvents) {
    try {
      // Corrections sync silently — attendees' calendars update without an
      // email per event (a season reconcile can touch many at once).
      const gcalId = await updateCalendarEvent(evt, { silent: true });
      if (gcalId) evt.gcalId = gcalId;
    } catch (e) {
      console.error("calendar update failed", e);
    }
  }

  const comm: Comm = {
    id: commId,
    receivedAt: now,
    source: c.source,
    people: c.people,
    owner: c.owner,
    category: c.category,
    subject: c.subject || "Quick note",
    summary: c.summary,
    reason: c.reason,
    raw: text || "(image attachment)",
    eventIds,
    todoIds,
  };

  await appendItems("comms", [comm]);
  if (newEvents.length || updatedEvents.length) await appendItems("events", [...newEvents, ...updatedEvents]);
  if (newTodos.length) await appendItems("todos", newTodos);
  const md = await applyMetadata(c.metadata, commId, now).catch(() => ({ applied: 0, suggested: 0 }));

  return {
    ok: true,
    category: c.category,
    summary: c.summary,
    people: c.people,
    events: newEvents.length,
    updated: updatedEvents.length,
    deletesQueued,
    todos: newTodos.length,
    metaApplied: md.applied,
    metaSuggested: md.suggested,
  };
}
