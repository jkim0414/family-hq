// NOTE: .js extension required — this module is also imported from api/ where
// Vercel's Node ESM runtime needs explicit extensions (Vite is fine either way).
import { toHomeZone } from "./tz.js";
import type { CalEvent, Todo } from "./types";

// Shared digest selection logic used by BOTH the emailed digest (api/digest.ts)
// and the in-app Digest view, so they never diverge.
//
// Daily  = "today + a few days of lead time": events in the next 3 days; to-dos
//          that are overdue or due within 5 days, plus high-priority undated ones.
//          (Undated normal-priority to-dos are NOT repeated every day.)
// Weekly = a full review: events in the next 7 days and ALL open to-dos.

export interface DigestSelection {
  events: CalEvent[];
  todos: Todo[];
  prep: CalEvent[];
}

// Time-bound urgency, shared by the app UI and the emailed digest: a to-do is
// urgent when due within URGENT_DAYS (~48h) or overdue; dateless to-dos fall
// back to the explicit high flag. `today` is the local (Pacific) YYYY-MM-DD —
// passed in because the server runs in UTC.
export const URGENT_DAYS = 2;
export function isTodoUrgent(
  t: { due?: string; done?: boolean; priority?: string },
  today: string
): boolean {
  if (t.done) return false;
  if (t.due) {
    const days = Math.round(
      (new Date(t.due + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000
    );
    return days <= URGENT_DAYS;
  }
  return t.priority === "high";
}

export function selectForDigest(
  allEvents: CalEvent[],
  allTodos: Todo[],
  today: string, // YYYY-MM-DD
  mode: "daily" | "weekly"
): DigestSelection {
  const du = (iso: string) =>
    Math.round((new Date(iso + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000);

  const eventLookahead = mode === "daily" ? 3 : 7;
  // Window/sort by the HOME-zone (PT) date+time — the stored date is in the
  // event's source zone and can fall on a different local day.
  const homeDate = (e: CalEvent) => toHomeZone(e).date;
  const homeKey = (e: CalEvent) => {
    const t = toHomeZone(e);
    return `${t.date} ${t.start || ""}`;
  };
  const events = allEvents
    .filter((e) => {
      const d = du(homeDate(e));
      return d >= 0 && d <= eventLookahead;
    })
    .sort((a, b) => homeKey(a).localeCompare(homeKey(b)));

  const open = allTodos.filter((t) => !t.done);
  const todos = open
    .filter((t) => {
      if (mode === "weekly") return true; // full review
      if (t.due) return du(t.due) <= 5; // overdue (negative) or due within 5 days
      return t.priority === "high"; // undated: only surface if high priority
    })
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));

  const prep = events.filter((e) => e.prep);
  return { events, todos, prep };
}
