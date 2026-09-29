import { useMemo, useState } from "react";
import { useData } from "../dataStore";
import { fmtDate, dateLabel, displayDate, isEventPast, homeSortKey } from "../store";
import { upcomingGroups, type AgendaItem } from "../agenda";
import { PEOPLE, peopleOf } from "../data/people";
import { PageHeader, SectionHeader, Empty, Card, Button } from "../components/ui";
import { EventCard } from "../components/EventCard";
import { TodoItem } from "../components/TodoItem";
import { EventEditor, TodoEditor, newEventDraft, newTodoDraft } from "../components/editors";
import type { CalEvent, Todo } from "../data/types";

type Show = "all" | "events" | "todos";

// Calendar and to-dos as one chronological list, grouped by day.
export default function Agenda() {
  const { data, toggleTodo } = useData();
  const [show, setShow] = useState<Show>("all");
  const [person, setPerson] = useState<string | null>(null);
  const [editEvent, setEditEvent] = useState<Partial<CalEvent> | null>(null);
  const [editTodo, setEditTodo] = useState<Partial<Todo> | null>(null);

  const { overdue, days, undated, past, done } = useMemo(() => {
    const forPerson = (x: { people?: string[]; kidIds?: string[]; owner?: string[] }) => !person || peopleOf(x).includes(person) || (x.owner || []).includes(person);
    const events = show === "todos" ? [] : data.events.filter(forPerson);
    const todos = show === "events" ? [] : data.todos.filter(forPerson);
    const groups = upcomingGroups(events, todos);
    const past = events.filter((e) => isEventPast(e)).sort((a, b) => homeSortKey(b).localeCompare(homeSortKey(a)));
    const done = todos.filter((t) => t.done);
    return { ...groups, past, done };
  }, [data.events, data.todos, show, person]);

  const renderItem = (it: AgendaItem) =>
    it.kind === "event" ? (
      <EventCard key={it.e.id} e={it.e} onEdit={() => setEditEvent(it.e)} showDate={false} />
    ) : (
      <Card key={it.t.id}>
        <TodoItem todo={it.t} done={false} onToggle={() => toggleTodo(it.t.id, true)} onEdit={() => setEditTodo(it.t)} showDue={false} />
      </Card>
    );

  const chip = (on: boolean) => `min-h-[36px] whitespace-nowrap rounded-full px-3 text-xs font-medium ${on ? "bg-ink text-surface" : "bg-surface text-ink-2 ring-1 ring-line"}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agenda"
        action={
          <div className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setEditTodo(newTodoDraft())}>
              + To-do
            </Button>
            <Button size="sm" onClick={() => setEditEvent(newEventDraft())}>
              + Event
            </Button>
          </div>
        }
      />

      <div className="no-scrollbar -mx-4 -my-1 flex gap-2 overflow-x-auto px-4 py-1 md:mx-0 md:px-0.5" role="tablist" aria-label="Filter">
        {(
          [
            ["all", "Everything"],
            ["events", "Events"],
            ["todos", "To-dos"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={show === k} onClick={() => setShow(k)} className={chip(show === k)}>
            {label}
          </button>
        ))}
        <span className="w-px shrink-0 bg-fill" aria-hidden />
        {PEOPLE.map((p) => (
          <button
            key={p.id}
            aria-pressed={person === p.id}
            onClick={() => setPerson(person === p.id ? null : p.id)}
            className="min-h-[36px] whitespace-nowrap rounded-full px-3 text-xs font-medium ring-1"
            style={person === p.id ? { background: p.color, color: "white", borderColor: p.color } : { background: "white", color: p.color, borderColor: "#e2e8f0" }}
          >
            {p.name}
          </button>
        ))}
      </div>

      {overdue.length > 0 && (
        <section>
          <SectionHeader title="Overdue" />
          <Card className="divide-y divide-line border-l-4 border-l-danger">
            {overdue.map((t) => (
              <TodoItem key={t.id} todo={t} done={false} onToggle={() => toggleTodo(t.id, true)} onEdit={() => setEditTodo(t)} />
            ))}
          </Card>
        </section>
      )}

      {days.length === 0 && overdue.length === 0 && undated.length === 0 && <Empty>Nothing coming up{person ? ` for ${PEOPLE.find((p) => p.id === person)?.name}` : ""}.</Empty>}

      {days.map((g) => (
        <section key={g.date}>
          <SectionHeader title={dateLabel(g.date)} hint={/^(Today|Tomorrow)$/.test(dateLabel(g.date)) ? fmtDate(g.date) : undefined} />
          <div className="space-y-2">{g.items.map(renderItem)}</div>
        </section>
      ))}

      {undated.length > 0 && (
        <section>
          <SectionHeader title="No date" />
          <Card className="divide-y divide-line">
            {undated.map((t) => (
              <TodoItem key={t.id} todo={t} done={false} onToggle={() => toggleTodo(t.id, true)} onEdit={() => setEditTodo(t)} />
            ))}
          </Card>
        </section>
      )}

      {(past.length > 0 || done.length > 0) && (
        <details className="group">
          <summary className="flex min-h-[36px] cursor-pointer list-none items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-ink-3">Past</span>
            <span className="text-xs font-medium text-accent">
              {past.length} events · {done.length} done <span className="inline-block transition group-open:rotate-90">›</span>
            </span>
          </summary>
          <div className="mt-2 space-y-4 opacity-70">
            {past.length > 0 && (
              <div className="space-y-2">
                {past.map((e) => (
                  <button key={e.id} type="button" className="block w-full text-left" onClick={() => setEditEvent(e)}>
                    <Card className="p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 break-words text-sm text-ink-2">{e.title}</div>
                        <div className="shrink-0 text-xs text-ink-3">{fmtDate(displayDate(e))}</div>
                      </div>
                    </Card>
                  </button>
                ))}
              </div>
            )}
            {done.length > 0 && (
              <Card className="divide-y divide-line">
                {done.map((t) => (
                  <TodoItem key={t.id} todo={t} done={true} onToggle={() => toggleTodo(t.id, false)} onEdit={() => setEditTodo(t)} />
                ))}
              </Card>
            )}
          </div>
        </details>
      )}

      {editEvent && <EventEditor event={editEvent} onClose={() => setEditEvent(null)} />}
      {editTodo && <TodoEditor todo={editTodo} onClose={() => setEditTodo(null)} />}
    </div>
  );
}
