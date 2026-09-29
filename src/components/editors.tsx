import { useData, newId } from "../dataStore";
import { todayISO } from "../store";
import { peopleOf, ownerOf } from "../data/people";
import { toHomeZone, HOME_TZ } from "../data/tz";
import { EntityForm, type FieldDef } from "./EntityForm";
import type { CalEvent, Todo } from "../data/types";

export const EVENT_FIELDS: FieldDef[] = [
  { key: "title", label: "Title", placeholder: "Event name", required: true },
  { key: "date", label: "Date", type: "date", required: true },
  { key: "allDay", label: "All day", type: "checkbox", placeholder: "All-day event" },
  { key: "start", label: "Start time", type: "time", showIf: (f) => !f.allDay },
  { key: "end", label: "End time", type: "time", showIf: (f) => !f.allDay },
  { key: "location", label: "Location", placeholder: "Where" },
  { key: "prep", label: "Notes", type: "textarea", placeholder: "What to bring/wear, confirmation #s, details…" },
  { key: "people", label: "For (who it's about)", type: "people" },
  { key: "owner", label: "Responsible", type: "people" },
];

export const TODO_FIELDS: FieldDef[] = [
  { key: "title", label: "Task", placeholder: "What needs doing", required: true },
  { key: "detail", label: "Detail", type: "textarea" },
  { key: "due", label: "Due", type: "date" },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    options: [
      { value: "normal", label: "Normal" },
      { value: "high", label: "High" },
    ],
  },
  { key: "people", label: "For (who it's about)", type: "people" },
  { key: "owner", label: "Responsible", type: "people" },
  { key: "done", label: "Done", type: "checkbox", placeholder: "Completed" },
];

export const newEventDraft = (): Partial<CalEvent> => ({
  id: newId("evt"),
  title: "",
  date: todayISO(),
  allDay: false,
  people: [],
  owner: [],
});

export const newTodoDraft = (): Partial<Todo> => ({
  id: newId("todo"),
  title: "",
  priority: "normal",
  done: false,
  people: [],
  owner: [],
});

export function EventEditor({ event, onClose }: { event: Partial<CalEvent>; onClose: () => void }) {
  const { data, mutate } = useData();
  const exists = data.events.some((e) => e.id === event.id);
  // Present (and save) times in the home zone: a source-zone event (e.g. an
  // ET-stamped GCal mirror) is converted to PT for editing, and saving pins it
  // to PT explicitly — what the user types is what the family's calendar shows.
  const inHome =
    event.date && !event.allDay && event.start
      ? (() => {
          const t = toHomeZone(event as CalEvent);
          // endDate: "" (not undefined) so a same-day conversion CLEARS any old
          // cross-day endDate on save instead of being dropped by the merge.
          return { ...event, date: t.date, start: t.start, end: t.end, endDate: t.endDate ?? "", startTz: HOME_TZ, endTz: HOME_TZ };
        })()
      : event;
  return (
    <EntityForm
      title={exists ? "Edit event" : "New event"}
      fields={EVENT_FIELDS}
      value={{ ...inHome, people: peopleOf(event), owner: ownerOf(event) }}
      onSave={(v) => {
        // All-day events carry no times ("" so the server merge clears old ones).
        if (v.allDay) Object.assign(v, { start: "", end: "", endDate: "" });
        mutate("events", "upsert", v as any);
        onClose();
      }}
      onDelete={exists ? () => { mutate("events", "delete", event as any); onClose(); } : undefined}
      onClose={onClose}
    />
  );
}

export function TodoEditor({ todo, onClose }: { todo: Partial<Todo>; onClose: () => void }) {
  const { data, mutate } = useData();
  const exists = data.todos.some((t) => t.id === todo.id);
  return (
    <EntityForm
      title={exists ? "Edit to-do" : "New to-do"}
      fields={TODO_FIELDS}
      value={{ ...todo, people: peopleOf(todo), owner: ownerOf(todo) }}
      onSave={(v) => {
        mutate("todos", "upsert", v as any);
        onClose();
      }}
      onDelete={exists ? () => { mutate("todos", "delete", todo as any); onClose(); } : undefined}
      onClose={onClose}
    />
  );
}
