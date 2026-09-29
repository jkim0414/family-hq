import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useData } from "../dataStore";
import { todayISO, fmtDate, isEventPast } from "../store";
import { dayGroups, addDays, type AgendaItem } from "../agenda";
import { PageHeader, SectionHeader, Empty, Card } from "../components/ui";
import { NeedsYou } from "../components/NeedsYou";
import { EventCard } from "../components/EventCard";
import { TodoItem } from "../components/TodoItem";
import { EventEditor, TodoEditor } from "../components/editors";
import type { CalEvent, Todo } from "../data/types";

// The briefing: what needs a decision, then today, tomorrow, and the rest of
// the week. This is the same selection the emailed digest uses.
export default function Home() {
  const { data, toggleTodo } = useData();
  const [editEvent, setEditEvent] = useState<Partial<CalEvent> | null>(null);
  const [editTodo, setEditTodo] = useState<Partial<Todo> | null>(null);

  const today = todayISO();
  const tomorrow = addDays(today, 1);
  const { todayItems, tomorrowItems, later } = useMemo(() => {
    const [todayItems, tomorrowItems] = dayGroups(data.events, data.todos, today, 2, true).map((g) => g.items);
    return { todayItems, tomorrowItems, later: dayGroups(data.events, data.todos, addDays(today, 2), 5) };
  }, [data.events, data.todos, today]);
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  const renderItem = (it: AgendaItem) =>
    it.kind === "event" ? (
      <div key={it.e.id} className={isEventPast(it.e) ? "opacity-50" : undefined}>
        <EventCard e={it.e} onEdit={() => setEditEvent(it.e)} showDate={false} />
      </div>
    ) : (
      <Card key={it.t.id}>
        <TodoItem todo={it.t} done={false} onToggle={() => toggleTodo(it.t.id, true)} onEdit={() => setEditTodo(it.t)} showDue={false} />
      </Card>
    );

  return (
    <div className="space-y-6">
      <PageHeader title="Home" subtitle={dateLine} />

      <section>
        <SectionHeader title="Needs you" />
        <NeedsYou />
      </section>

      <section>
        <SectionHeader title="Today" />
        {todayItems.length ? <div className="space-y-2">{todayItems.map(renderItem)}</div> : <Empty>Nothing scheduled today.</Empty>}
      </section>

      <section>
        <SectionHeader title="Tomorrow" hint={fmtDate(tomorrow)} />
        {tomorrowItems.length ? <div className="space-y-2">{tomorrowItems.map(renderItem)}</div> : <Empty>Nothing scheduled tomorrow.</Empty>}
      </section>

      <section>
        <details className="group">
          <summary className="flex min-h-[36px] cursor-pointer list-none items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-ink-3">Later this week</span>
            <span className="text-xs font-medium text-accent">
              {later.reduce((n, g) => n + g.items.length, 0)} items <span className="inline-block transition group-open:rotate-90">›</span>
            </span>
          </summary>
          <div className="mt-2 space-y-4">
            {later.length === 0 && <Empty>Nothing else this week.</Empty>}
            {later.map((g) => (
              <div key={g.date}>
                <div className="mb-1.5 text-xs font-semibold text-ink-3">{fmtDate(g.date)}</div>
                <div className="space-y-2">{g.items.map(renderItem)}</div>
              </div>
            ))}
          </div>
        </details>
      </section>

      <Link to="/agenda" className="flex min-h-[48px] items-center justify-between rounded-2xl bg-surface px-4 text-sm font-medium text-ink-2 shadow-sm ring-1 ring-line">
        <span>Full agenda</span>
        <span className="text-ink-4">›</span>
      </Link>

      {editEvent && <EventEditor event={editEvent} onClose={() => setEditEvent(null)} />}
      {editTodo && <TodoEditor todo={editTodo} onClose={() => setEditTodo(null)} />}
    </div>
  );
}
