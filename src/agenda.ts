import { todayISO, daysUntil, displayDate, isEventPast, homeSortKey, isTodoUrgent } from "./store";
import type { CalEvent, Todo } from "./data/types";

// One chronological stream of "things happening": events and due to-dos,
// grouped by home-zone day. Shared by Home (today / tomorrow / this week)
// and Agenda (everything).

export type AgendaItem = { kind: "event"; e: CalEvent } | { kind: "todo"; t: Todo };

export interface DayGroup {
  date: string; // YYYY-MM-DD, or "" for undated to-dos
  items: AgendaItem[];
}

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Group events and open to-dos by home-zone day, once. */
function byDay(events: CalEvent[], todos: Todo[]): Map<string, AgendaItem[]> {
  const map = new Map<string, AgendaItem[]>();
  const push = (date: string, it: AgendaItem) => {
    const list = map.get(date);
    if (list) list.push(it);
    else map.set(date, [it]);
  };
  const sortedEvents = [...events].sort((a, b) => homeSortKey(a).localeCompare(homeSortKey(b)));
  for (const e of sortedEvents) push(displayDate(e), { kind: "event", e });
  for (const t of todos) if (!t.done && t.due) push(t.due, { kind: "todo", t });
  return map;
}

/** Items for one day: all-day events, timed events by start, then to-dos due that day. */
export function itemsForDay(events: CalEvent[], todos: Todo[], date: string): AgendaItem[] {
  return byDay(events, todos).get(date) || [];
}

/** Consecutive day groups starting at `from` for `days` days (empty days omitted unless `keepEmpty`). */
export function dayGroups(events: CalEvent[], todos: Todo[], from: string, days: number, keepEmpty = false): DayGroup[] {
  const map = byDay(events, todos);
  const out: DayGroup[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const items = map.get(date) || [];
    if (items.length || keepEmpty) out.push({ date, items });
  }
  return out;
}

/** Everything upcoming, grouped by day, plus overdue to-dos first and undated to-dos last. */
export function upcomingGroups(events: CalEvent[], todos: Todo[]): { overdue: Todo[]; days: DayGroup[]; undated: Todo[] } {
  const today = todayISO();
  const open = todos.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due && daysUntil(t.due) < 0).sort((a, b) => a.due!.localeCompare(b.due!));
  const undated = open.filter((t) => !t.due);
  const map = byDay(events.filter((e) => !isEventPast(e)), open.filter((t) => t.due && t.due >= today));
  const days = [...map.keys()].sort().map((date) => ({ date, items: map.get(date)! }));
  return { overdue, days, undated };
}

/** To-dos that need a decision now: overdue or due within ~48h (and dateless high-priority). */
export function urgentTodos(todos: Todo[]): Todo[] {
  return todos.filter((t) => !t.done && isTodoUrgent(t)).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
}

export { addDays };
