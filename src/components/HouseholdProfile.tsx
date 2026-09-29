import { useState } from "react";
import { useData, newId } from "../dataStore";
import { formatPhone } from "../store";
import { Card, Collapsible, TextAction } from "./ui";
import { EntityForm, type FieldDef } from "./EntityForm";
import type { ProfilePerson } from "../data/types";

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

// The standing household facts that power EA-style inference, editable in-app.
export function HouseholdProfile() {
  const { data, saveProfile } = useData();
  const p = data.profile;
  const [editSection, setEditSection] = useState<{ key: string; title: string; body: string } | null>(null);
  const [editPerson, setEditPerson] = useState<Partial<ProfilePerson> | null>(null);

  const saveSection = (v: Record<string, any>) => {
    saveProfile({ ...p, sections: p.sections.map((s) => (s.key === editSection!.key ? { ...s, body: v.body } : s)) });
    setEditSection(null);
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
      <Collapsible id="facts" title="Household facts" count={p.sections.length} defaultOpen={false} hint="Standing facts Kimi uses to plan ahead (allergies, vendors, work hours…).">
        <div className="space-y-2">
          {p.sections.map((s) => (
            <Card key={s.key} className="p-4">
              <button type="button" className="block w-full text-left" onClick={() => setEditSection(s)}>
                <div className="text-sm font-bold text-ink">{s.title}</div>
                <div className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-2">{s.body || "—"}</div>
              </button>
            </Card>
          ))}
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

      {editSection && (
        <EntityForm
          title={`Edit: ${editSection.title}`}
          fields={[{ key: "body", label: editSection.title, type: "textarea" }]}
          value={{ body: editSection.body }}
          onSave={saveSection}
          onClose={() => setEditSection(null)}
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
