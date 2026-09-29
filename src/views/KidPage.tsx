import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { relativeDay, isEventPast, formatPhone, displayDate, homeSortKey } from "../store";
import { peopleOf } from "../data/people";
import { useData } from "../dataStore";
import { Card, PageHeader, Empty, SourceBadge, SectionHeader, Button, Collapsible } from "../components/ui";
import { TodoItem } from "../components/TodoItem";
import { EntityForm, type FieldDef } from "../components/EntityForm";
import type { KidId } from "../data/types";

const KID_FIELDS: FieldDef[] = [
  { key: "firstName", label: "First name", required: true },
  { key: "fullName", label: "Full name", required: true },
  { key: "currentSchool", label: "School (now)" },
  { key: "currentProgram", label: "Program (now)" },
  { key: "currentTeachers", label: "Teacher(s) now", placeholder: "Comma-separated" },
  { key: "currentAftercare", label: "After school (now)" },
  { key: "fallSchool", label: "School (fall)" },
  { key: "fallProgram", label: "Program (fall)" },
  { key: "fallTeachers", label: "Teacher(s) fall", placeholder: "Comma-separated" },
  { key: "fallAftercare", label: "After school (fall)" },
];

export default function KidPage() {
  const { id } = useParams();
  const { data, toggleTodo, mutate } = useData();
  const [editing, setEditing] = useState(false);

  const k = data.kids.find((x) => x.id === id);
  if (!k) return <Empty>Unknown child.</Empty>;
  const kid = k.id as KidId;

  const contacts = data.contacts.filter((c) => c.kidIds.includes(kid));
  const routines = data.routines.filter((r) => r.kidId === kid);
  const events = data.events
    .filter((e) => peopleOf(e).includes(kid) && !isEventPast(e))
    .sort((a, b) => homeSortKey(a).localeCompare(homeSortKey(b)));
  const todos = data.todos.filter((t) => peopleOf(t).includes(kid) && !t.done);
  const comms = data.comms
    .filter((c) => peopleOf(c).includes(kid))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, 5);

  // Only show next fall once it's actually known — "2nd Grade — TBD" is noise.
  const showFall = !!k.fall.program && k.fall.teachers.length > 0 && !k.fall.teachers.some((t) => /tbd/i.test(t));

  const flatKid = {
    id: k.id,
    firstName: k.firstName,
    fullName: k.fullName,
    currentSchool: k.current.school,
    currentProgram: k.current.program,
    currentTeachers: k.current.teachers.join(", "),
    currentAftercare: k.current.aftercare || "",
    fallSchool: k.fall.school,
    fallProgram: k.fall.program,
    fallTeachers: k.fall.teachers.join(", "),
    fallAftercare: k.fall.aftercare || "",
  };

  const saveKid = (v: Record<string, any>) => {
    const split = (s: string) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
    mutate("kids", "upsert", {
      ...k,
      firstName: v.firstName,
      fullName: v.fullName,
      current: { school: v.currentSchool, program: v.currentProgram, teachers: split(v.currentTeachers), aftercare: v.currentAftercare },
      fall: { school: v.fallSchool, program: v.fallProgram, teachers: split(v.fallTeachers), aftercare: v.fallAftercare },
    } as any);
    setEditing(false);
  };

  return (
    <div className="space-y-5">
      <Link to="/household" className="-my-2 inline-flex min-h-[36px] items-center text-sm font-medium text-accent">
        ‹ Household
      </Link>
      <PageHeader
        title={k.fullName}
        subtitle={`${k.current.program} · ${k.current.school}`}
        action={
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        }
      />

      <Card className="p-4" accent={k.color}>
        <Row label="Now">
          {k.current.program} — {k.current.teachers.join(", ")}
        </Row>
        {k.current.aftercare && <Row label="After school">{k.current.aftercare}</Row>}
        {showFall && (
          <Row label="Next fall">
            {k.fall.program} — {k.fall.teachers.join(", ")} @ {k.fall.school}
          </Row>
        )}
      </Card>

      <Section title="Drop-off / Pick-up">
        <Card className="divide-y divide-line">
          {routines.map((r) => (
            <div key={r.id} className="px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">{r.label}</div>
              <div className="text-sm text-ink-2">{r.detail || <span className="text-ink-4">— add in Directory —</span>}</div>
            </div>
          ))}
        </Card>
      </Section>

      <Section title="Contacts" fold count={contacts.length}>
        <Card className="divide-y divide-line">
          {contacts.map((c) => (
            <div key={c.id} className="px-4 py-3">
              <div className="text-[15px] font-semibold text-ink">{c.name}</div>
              <div className="text-[13px] text-ink-3">{c.role}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[13px] text-accent">
                {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
                {c.phone && <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>{formatPhone(c.phone)}</a>}
                {!c.email && !c.phone && <span className="text-ink-4">— add in Household —</span>}
              </div>
            </div>
          ))}
        </Card>
      </Section>

      <Section title="Upcoming">
        {events.length === 0 ? (
          <Empty>Nothing scheduled.</Empty>
        ) : (
          <div className="space-y-2">
            {events.map((e) => (
              <Card key={e.id} className="p-3">
                <div className="flex justify-between">
                  <span className="text-sm font-medium text-ink">{e.title}</span>
                  <span className="text-xs text-accent">{relativeDay(displayDate(e))}</span>
                </div>
                {e.prep && <div className="mt-1 text-xs text-warn">📋 {e.prep}</div>}
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="To-dos">
        {todos.length === 0 ? (
          <Empty>None open.</Empty>
        ) : (
          <Card className="divide-y divide-line">
            {todos.map((t) => (
              <TodoItem key={t.id} todo={t} done={false} onToggle={() => toggleTodo(t.id, true)} />
            ))}
          </Card>
        )}
      </Section>

      <Section title="Recent messages" fold count={comms.length}>
        <Card className="divide-y divide-line">
          {comms.map((c) => (
            <div key={c.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{c.subject}</span>
                <SourceBadge source={c.source} />
              </div>
              <div className="text-xs text-ink-3">{c.summary}</div>
            </div>
          ))}
        </Card>
      </Section>

      {editing && (
        <EntityForm title={`Edit ${k.firstName}`} fields={KID_FIELDS} value={flatKid} onSave={saveKid} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <span className="w-24 shrink-0 text-ink-3">{label}</span>
      <span className="text-ink">{children}</span>
    </div>
  );
}

function Section({ title, children, fold, count }: { title: string; children: React.ReactNode; fold?: boolean; count?: number }) {
  if (fold)
    return (
      <Collapsible id={`kid-${title.toLowerCase().replace(/\W+/g, "-")}`} title={title} count={count} defaultOpen={false}>
        {children}
      </Collapsible>
    );
  return (
    <section>
      <SectionHeader title={title} />
      {children}
    </section>
  );
}
