// Lightweight title-similarity used to avoid creating duplicate calendar events
// (both against pre-existing calendar entries and other emails in the same batch).

const STOP = new Set([
  "the", "of", "for", "and", "with", "a", "an", "to", "at", "on", "in", "is",
  "our", "your", "this", ]);

function tokens(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

// Words that describe the KIND of thing rather than WHICH thing. Two titles that
// share only these ("Wrap a gift for Maya" / "Wrap a gift for Theo") are
// different items; the remaining words (names, places, subjects) must overlap.
const GENERIC = new Set([
  "birthday", "bday", "party", "parties", "celebration", "celebrate", "gift", "gifts", "card", "cards", "wrap", "write",
  "buy", "get", "order", "pick", "bring", "pack", "make", "prepare", "prep", "sign", "rsvp", "send", "book", "schedule",
  "confirm", "call", "email", "reply", "renew", "pay", "clear", "work", "calendar", "reminder", "remind",
  "game", "games", "practice", "class", "classes", "lesson", "lessons", "meeting", "appointment", "visit", "trip",
  "event", "day", "night", "morning", "afternoon", "evening", "week", "weekend", "today", "tomorrow",
  "school", "kids", "kid", "family", "fam", "treats", "snacks", "snack", "lunch", "dinner", "breakfast",
  "allergy", "safe", "costume", "costumes", "dish", "form", "slip", "permission",
  "annual", "belated", "first", "last", "new", "big", "little", "all", "only", "from", "via", "into", "about",
]);

/** Names in a title: non-generic words written with a capital letter ("Maya", "Nguyen", "MLK"). */
function names(s: string): Set<string> {
  const capitalized = new Set((s.match(/\b[A-Z][A-Za-z']*/g) || []).map((w) => w.toLowerCase().replace(/'s?$/, "")));
  const out = new Set<string>();
  for (const w of tokens(s)) {
    const base = w.replace(/s$/, "");
    if (GENERIC.has(w) || GENERIC.has(base) || /^\d/.test(w)) continue;
    if (capitalized.has(w) || capitalized.has(base)) out.add(w);
  }
  return out;
}

/** True if two titles likely describe the same thing. */
export function titlesSimilar(a: string, b: string): boolean {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  if (inter / Math.min(A.size, B.size) < 0.6) return false;
  // The same kind of thing for different people/places isn't the same thing:
  // when both titles name someone/somewhere, at least one name must match.
  const nA = names(a);
  const nB = names(b);
  if (nA.size && nB.size && ![...nA].some((w) => nB.has(w))) return false;
  return true;
}

/** Same calendar day + similar title → treat as the same event. */
export function eventsSimilar(
  a: { date: string; title: string; endDate?: string },
  b: { date: string; title: string; endDate?: string }
): boolean {
  if (!titlesSimilar(a.title, b.title)) return false;
  if (a.date === b.date) return true;
  // A day inside a span is the same thing ("Thanksgiving Break" Nov 23–27 vs a single "Thanksgiving
  // Break" on Nov 25), and so are two overlapping spans of it.
  const aEnd = a.endDate || a.date, bEnd = b.endDate || b.date;
  return a.date <= bEnd && b.date <= aEnd && (!!a.endDate || !!b.endDate);
}

import { peopleOf } from "../../src/data/people.js";

interface CommLike {
  receivedAt: string;
  people?: string[];
  kidIds?: string[];
  subject: string;
  summary: string;
}

/**
 * Detects the "same communication forwarded twice" case (e.g. both parents
 * forward the same school email — different IMAP UIDs, so UID-tracking misses it).
 * Requires multiple matching signals to avoid merging genuinely distinct emails:
 * received within a week, overlapping kids, AND similar subject + summary.
 */
export function commsDuplicate(a: CommLike, b: CommLike): boolean {
  const days = Math.abs((Date.parse(a.receivedAt) - Date.parse(b.receivedAt)) / 86400000);
  if (!(days <= 7)) return false;
  const pa = peopleOf(a);
  const pb = peopleOf(b);
  const overlap = pa.length === 0 || pb.length === 0 || pa.some((k) => pb.includes(k));
  if (!overlap) return false;
  return titlesSimilar(a.subject, b.subject) && titlesSimilar(a.summary, b.summary);
}

/**
 * Update an existing event in place with newly-classified details (e.g. an
 * "updated details for X" re-forward). Only overwrites with provided values, so
 * a re-send that omits a field doesn't wipe it.
 */
export function mergeEventDetails(target: any, src: any): void {
  if (src.title) target.title = src.title;
  if (typeof src.allDay === "boolean") target.allDay = src.allDay;
  if (src.start !== undefined) target.start = src.start;
  if (src.end !== undefined) target.end = src.end;
  if (src.endDate !== undefined) target.endDate = src.endDate;
  if (src.startTz !== undefined) target.startTz = src.startTz;
  if (src.endTz !== undefined) target.endTz = src.endTz;
  if (src.location !== undefined) target.location = src.location;
  if (src.prep !== undefined) target.prep = src.prep;
  if (src.date) target.date = src.date;
  if (src.people?.length) target.people = src.people;
  if (src.owner?.length) target.owner = src.owner;
}

/**
 * Two to-dos are the same task when their titles match and they're due within
 * a few days of each other (or both are undated). Used to keep a reminder from
 * three sources — the school digest, a room parent's email, a calendar entry —
 * from becoming three to-dos.
 */
export function todosSimilar(a: { title: string; due?: string }, b: { title: string; due?: string }): boolean {
  if (!titlesSimilar(a.title, b.title)) return false;
  if (!a.due || !b.due) return !a.due && !b.due;
  return Math.abs(Date.parse(a.due) - Date.parse(b.due)) <= 3 * 86400000;
}

const PREP_RE = /^\s*(buy|get|purchase|pick up|order|prepare|prep|make|bake|cook|pack|wrap|print|fill out|sign|label|gather|assemble|find|borrow|iron|wash)\b/i;

/**
 * A prep task for something that happens on day D can't be due on D — the
 * kids need it in hand that morning. If the model dated a prep to-do on the
 * event day itself, pull it to the day before.
 */
export function adjustPrepDue<T extends { title: string; due?: string }>(todo: T, eventDates: string[]): T {
  if (todo.due && eventDates.includes(todo.due) && PREP_RE.test(todo.title)) todo.due = prevDay(todo.due);
  return todo;
}

/** YYYY-MM-DD one day after the given date. */
export function nextDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD one day before the given date. */
export function prevDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
