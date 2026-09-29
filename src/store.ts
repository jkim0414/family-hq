import { KIDS, kidById } from "./data/kids";
import { CONTACTS, PLACES, ROUTINES } from "./data/meta";
import { isTodoUrgent as isTodoUrgentOn, URGENT_DAYS } from "./data/digest";
import { toHomeZone, eventEndUtc, fmt12, homeSortKey } from "./data/tz";
export { homeSortKey };
import type { KidId } from "./data/types";

// Roster + meta are stable; re-exported for convenience. Dynamic collections
// (comms / events / todos) come from the live data store via useData().
export { KIDS, kidById, CONTACTS, PLACES, ROUTINES };

// ── Date helpers ─────────────────────────────────────────────────────────────

// LOCAL calendar date (not UTC) — using toISOString() here shifts the date in the
// evening for negative-UTC zones, making "tomorrow" read as "today".
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function daysUntil(iso: string): number {
  const a = new Date(todayISO() + "T00:00:00").getTime();
  const b = new Date(iso + "T00:00:00").getTime();
  return Math.round((b - a) / 86400000);
}

export function relativeDay(iso: string): string {
  const n = daysUntil(iso);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n < 0) return `${-n} days ago`;
  if (n < 7) return `In ${n} days`;
  return fmtDate(iso);
}

/** Actual date label, but "Today"/"Tomorrow"/"Yesterday" for the near term. */
export function dateLabel(iso: string): string {
  const n = daysUntil(iso);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  return fmtDate(iso); // e.g. "Tue, Jun 9"
}

/** True once an event is over — true instant, honoring the event's source zone. */
export function isEventPast(e: { date: string; allDay: boolean; start?: string; end?: string; endDate?: string; startTz?: string; endTz?: string }): boolean {
  // All-day events show through their whole last day (endDate covers multi-day spans).
  if (e.allDay) return daysUntil(e.endDate || e.date) < 0;
  return eventEndUtc(e).getTime() < Date.now();
}

// ── Time display: everything renders in the family's home zone (PT) ──────────
// Events are stored in their SOURCE zone (email / GCal); display converts.

/** The event's start date as seen in the home zone (use for labels/sorting/grouping). */
export function displayDate(e: { date: string; allDay: boolean; start?: string; end?: string; endDate?: string; startTz?: string; endTz?: string }): string {
  return toHomeZone(e).date;
}

/**
 * Human time range for an event, converted to the home zone (PT). Always
 * labeled "PT" so there's never ambiguity about the display zone; "(+Nd)"
 * marks an event ending on a later day (e.g. a red-eye).
 */
export function eventTimeRange(e: {
  allDay: boolean;
  date: string;
  start?: string;
  end?: string;
  endDate?: string;
  startTz?: string;
  endTz?: string;
}): string {
  // Multi-day all-day span (a school break, a trip) → show the range end.
  if (e.allDay) return e.endDate && e.endDate !== e.date ? `Through ${fmtDate(e.endDate)}` : "All day";
  const t = toHomeZone(e);
  if (!t.start) return "";
  let out = fmt12(t.start);
  if (t.end) {
    let endStr = fmt12(t.end);
    if (t.endDate && t.endDate !== t.date) {
      const dd = Math.round((Date.parse(t.endDate + "T00:00:00") - Date.parse(t.date + "T00:00:00")) / 86400000);
      if (dd > 0) endStr += ` (+${dd}d)`;
    }
    out += ` – ${endStr}`;
  }
  return `${out} PT`;
}

// A to-do counts as urgent (red "High" pill, surfaced on Today) when it's
// TIME-BOUND: due within ~48h (today/tomorrow) or already overdue. Dateless
// to-dos fall back to an explicit high flag set in the editor (rare).
// Single source of truth lives in data/digest.ts (shared with the email digest).
export { URGENT_DAYS };
export function isTodoUrgent(t: { due?: string; done?: boolean; priority?: string }): boolean {
  return isTodoUrgentOn(t, todayISO());
}

export const kidColor = (id: KidId) => kidById(id)?.color || "#64748b";

/** Normalize a phone number to a clean display format; leaves intl/other as-is. */
export function formatPhone(raw?: string): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return raw.trim();
}

export const SOURCE_LABEL: Record<string, string> = {
  parentsquare: "ParentSquare",
  aeries: "Aeries",
  band: "BAND",
  brightwheel: "Brightwheel",
  email: "Email",
  text: "Text",
  calendar: "Calendar",
  other: "Other",
};
