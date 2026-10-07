import { useState } from "react";
import { useData, newId } from "../dataStore";
import { formatPhone } from "../store";
import { Card, Collapsible, TextAction } from "./ui";
import { EntityForm, type FieldDef } from "./EntityForm";
import type { Fact, ProfilePerson } from "../data/types";
import { FACT_TOPICS, newFactId } from "../data/facts";
import { personName } from "../data/people";

const RELATIONS = [
  { value: "Friend family", label: "Friend family" },
  { value: "Relative (helps with childcare)", label: "Relative" },
  { value: "Service", label: "Service" },
  { value: "Other", label: "Other" },
];

const PERSON_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", required: true },
  { key: "phone", label: "Phone", type: "phone" },
  { key: "relation", label: "Relation", type: "select", options: RELATIONS },
  { key: "venmo", label: "Venmo username", placeholder: "for one-tap payments (without @)" },
  { key: "note", label: "Note", type: "textarea", placeholder: "Partner, kids, role…" },
];

const FACT_FIELDS: FieldDef[] = [
  { key: "text", label: "Fact", type: "textarea", required: true, placeholder: "One sentence: \"Ava's swim lessons are Saturdays at 9\"" },
  { key: "topic", label: "Topic", type: "select", options: FACT_TOPICS.map((t) => ({ value: t.id, label: t.label })) },
  { key: "about", label: "About", type: "people" },
];

// The standing household facts Kimi works from, by topic — editable in-app (by a parent).
export function HouseholdProfile() {
  const { data, saveProfile } = useData();
  const p = data.profile;
  const readOnly = data.me?.role === "caregiver";
  const [editFact, setEditFact] = useState<Partial<Fact> | null>(null);
  const [editPerson, setEditPerson] = useState<Partial<ProfilePerson> | null>(null);

  const saveFact = (v: Record<string, any>) => {
    const next: Fact = { id: v.id || newFactId(), topic: v.topic || "other", text: String(v.text).trim(), updatedAt: new Date().toISOString(), ...(v.about?.length ? { about: v.about } : {}) };
    const exists = p.facts.some((f) => f.id === next.id);
    saveProfile({ ...p, facts: exists ? p.facts.map((f) => (f.id === next.id ? next : f)) : [...p.facts, next] });
    setEditFact(null);
  };
  const delFact = () => {
    saveProfile({ ...p, facts: p.facts.filter((f) => f.id !== editFact!.id) });
    setEditFact(null);
  };
  const savePerson = (v: Record<string, any>) => {
    const exists = p.people.some((x) => x.id === v.id);
    const people = exists ? p.people.map((x) => (x.id === v.id ? { ...x, ...v } : x)) : [...p.people, v as ProfilePerson];
    saveProfile({ ...p, people });
    setEditPerson(null);
  };
  const delPerson = () => {
    saveProfile({ ...p, people: p.people.filter((x) => x.id !== editPerson!.id) });
    setEditPerson(null);
  };

  const groups: Record<string, ProfilePerson[]> = {};
  for (const person of p.people) (groups[person.relation] ||= []).push(person);

  return (
    <>
      <Collapsible
        id="facts"
        title="Household facts"
        count={p.facts.length}
        defaultOpen={false}
        hint="Standing facts Kimi plans with (allergies, vendors, work hours…). Tell her something new and she updates the fact it changes."
        actions={readOnly ? undefined : <TextAction onClick={() => setEditFact({ topic: "other", text: "" })}>+ Add</TextAction>}
      >
        <div className="space-y-3">
          {FACT_TOPICS.map((t) => {
            const fs = p.facts.filter((f) => (f.topic || "other") === t.id);
            if (!fs.length) return null;
            return (
              <div key={t.id}>
                <div className="mb-1 text-xs font-medium text-ink-3">{t.label}</div>
                <Card className="divide-y divide-line">
                  {fs.map((f) => (
                    <button key={f.id} type="button" disabled={readOnly} className="block w-full px-4 py-3 text-left" onClick={() => setEditFact(f)}>
                      <div className="break-words text-sm text-ink">{f.text}</div>
                      {!!f.about?.length && <div className="mt-0.5 text-xs text-ink-3">{f.about.map(personName).join(", ")}</div>}
                    </button>
                  ))}
                </Card>
              </div>
            );
          })}
        </div>
      </Collapsible>

      <Collapsible
        id="people"
        title="People we rely on"
        count={p.people.length}
        defaultOpen={false}
        actions={<TextAction onClick={() => setEditPerson({ id: newId("p"), name: "", relation: "Friend family" })}>+ Add</TextAction>}
      >
        <div className="space-y-3">
          {Object.entries(groups).map(([rel, ppl]) => (
            <div key={rel}>
              <div className="mb-1 text-xs font-medium text-ink-3">{rel}</div>
              <Card className="divide-y divide-line">
                {ppl.map((person) => (
                  <button key={person.id} type="button" className="block w-full px-4 py-3 text-left" onClick={() => setEditPerson(person)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-ink">{person.name}</span>
                      {person.phone && <span className="shrink-0 text-xs text-accent">{formatPhone(person.phone)}</span>}
                    </div>
                    {person.note && <div className="break-words text-xs text-ink-3">{person.note}</div>}
                  </button>
                ))}
              </Card>
            </div>
          ))}
        </div>
      </Collapsible>

      {editFact && (
        <EntityForm
          title={editFact.id ? "Edit fact" : "New fact"}
          fields={FACT_FIELDS}
          value={editFact}
          onSave={saveFact}
          onDelete={editFact.id ? delFact : undefined}
          onClose={() => setEditFact(null)}
        />
      )}
      {editPerson && (
        <EntityForm
          title={p.people.some((x) => x.id === editPerson.id) ? "Edit person" : "New person"}
          fields={PERSON_FIELDS}
          value={editPerson}
          onSave={savePerson}
          onDelete={p.people.some((x) => x.id === editPerson.id) ? delPerson : undefined}
          onClose={() => setEditPerson(null)}
        />
      )}
    </>
  );
}
