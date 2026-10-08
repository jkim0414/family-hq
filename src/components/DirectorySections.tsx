import { useState } from "react";
import { formatPhone } from "../store";
import { useData, newId } from "../dataStore";
import { Card, PeopleChips, Collapsible, TextAction } from "./ui";
import { EntityForm, type FieldDef } from "./EntityForm";

// Places, contacts, and drop-off / pick-up routines — the editable directory.

const PLACE_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", required: true },
  {
    key: "kind",
    label: "Type",
    type: "select",
    options: [
      { value: "school", label: "School" },
      { value: "daycare", label: "Daycare" },
      { value: "aftercare", label: "Aftercare" },
    ],
  },
  { key: "address", label: "Address" },
  { key: "phone", label: "Phone", type: "phone" },
  { key: "website", label: "Website", type: "url" },
  { key: "notes", label: "Notes", type: "textarea" },
];

const CONTACT_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", required: true },
  { key: "role", label: "Role" },
  { key: "org", label: "Organization" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone", type: "phone" },
  { key: "venmo", label: "Venmo username", placeholder: "for one-tap payments (without @)" },
  { key: "kidIds", label: "Kids", type: "kids" },
];

// The kid options come from the signed-in data (routineFields below).
const routineFields = (kids: { id: string; firstName: string }[]): FieldDef[] => [
  { key: "kidId", label: "Kid", type: "select", options: kids.map((k) => ({ value: k.id, label: k.firstName })) },
  { key: "label", label: "Label", placeholder: "Drop-off / Pick-up" },
  { key: "detail", label: "Detail", type: "textarea" },
];

type Editing = { kind: "places" | "contacts" | "routines"; item: Record<string, any> } | null;

export function DirectorySections() {
  const { data, mutate } = useData();
  const [editing, setEditingState] = useState<Editing>(null);
  // The directory is the parents' to edit; the caregiver reads it (calls and emails still work).
  const readOnly = data.me?.role === "caregiver";
  const setEditing = (e: Editing) => !readOnly && setEditingState(e);

  const fieldsFor = (k: string) => (k === "places" ? PLACE_FIELDS : k === "contacts" ? CONTACT_FIELDS : routineFields(data.kids));
  const titleFor = (k: string) => ({ places: "place", contacts: "contact", routines: "routine" })[k];

  return (
    <>
      <Section id="places" title="Places" count={data.places.length} onAdd={readOnly ? undefined : () => setEditing({ kind: "places", item: { id: newId("place"), name: "", kind: "school" } })}>
        {data.places.map((p) => (
          <Card key={p.id} className="p-4">
            <button type="button" className="block w-full text-left" onClick={() => setEditing({ kind: "places", item: p })}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-ink">{p.name}</div>
                <span className="rounded-md bg-fill px-1.5 py-0.5 text-xs capitalize text-ink-3">{p.kind}</span>
              </div>
              <Field label="Address" value={p.address} />
              <Field label="Phone" value={p.phone} tel />
              {p.notes && <div className="mt-1 text-xs text-ink-3">{p.notes}</div>}
            </button>
          </Card>
        ))}
      </Section>

      <Section id="contacts" title="Contacts" count={data.contacts.length} onAdd={readOnly ? undefined : () => setEditing({ kind: "contacts", item: { id: newId("contact"), name: "", role: "", kidIds: [] } })}>
        <Card className="divide-y divide-line">
          {data.contacts.map((c) => (
            <button key={c.id} type="button" className="block w-full px-4 py-3 text-left" onClick={() => setEditing({ kind: "contacts", item: c })}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-ink">{c.name}</div>
                  <div className="text-[13px] text-ink-3">{[c.role, c.org].filter(Boolean).join(" · ")}</div>
                </div>
                {c.kidIds?.length > 0 && (
                  <div className="shrink-0">
                    <PeopleChips ids={c.kidIds} />
                  </div>
                )}
              </div>
              {(c.email || c.phone) && (
                <div className="mt-1 flex flex-wrap gap-x-3 text-[13px]">
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="text-accent" onClick={(e) => e.stopPropagation()}>
                      {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="text-accent" onClick={(e) => e.stopPropagation()}>
                      {formatPhone(c.phone)}
                    </a>
                  )}
                </div>
              )}
            </button>
          ))}
        </Card>
      </Section>

      <Section id="routines" title="Drop-off / Pick-up" count={data.routines.length} onAdd={readOnly ? undefined : () => setEditing({ kind: "routines", item: { id: newId("r"), kidId: "max", label: "Drop-off", detail: "" } })}>
        <Card className="divide-y divide-line">
          {data.routines.map((r) => (
            <button key={r.id} type="button" className="block w-full px-4 py-3 text-left" onClick={() => setEditing({ kind: "routines", item: r })}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-ink">{data.kids.find((k) => k.id === r.kidId)?.firstName}</span>
                <span className="text-xs text-ink-3">{r.label}</span>
              </div>
              <div className="text-sm text-ink-2">{r.detail || <span className="text-ink-4">— add detail —</span>}</div>
            </button>
          ))}
        </Card>
      </Section>

      {editing && (
        <EntityForm
          title={`${data[editing.kind].some((x: any) => x.id === editing.item.id) ? "Edit" : "New"} ${titleFor(editing.kind)}`}
          fields={fieldsFor(editing.kind)}
          value={editing.item}
          onSave={(v) => {
            mutate(editing.kind, "upsert", v as any);
            setEditing(null);
          }}
          onDelete={
            data[editing.kind].some((x: any) => x.id === editing.item.id)
              ? () => {
                  mutate(editing.kind, "delete", editing.item as any);
                  setEditing(null);
                }
              : undefined
          }
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function Section({ id, title, count, onAdd, children }: { id: string; title: string; count: number; onAdd?: () => void; children: React.ReactNode }) {
  return (
    <Collapsible id={id} title={title} count={count} defaultOpen={false} actions={onAdd && <TextAction onClick={onAdd}>+ Add</TextAction>}>
      <div className="space-y-2">{children}</div>
    </Collapsible>
  );
}

function Field({ label, value, tel, mailto }: { label: string; value?: string; tel?: boolean; mailto?: boolean }) {
  const display = tel ? formatPhone(value) : value;
  const href = value ? (tel ? `tel:${value.replace(/[^\d+]/g, "")}` : mailto ? `mailto:${value}` : undefined) : undefined;
  return (
    <div className="mt-1 flex gap-2 text-xs">
      <span className="w-16 shrink-0 text-ink-3">{label}</span>
      {value ? (
        href ? (
          <a href={href} className="text-accent" onClick={(e) => e.stopPropagation()}>
            {display}
          </a>
        ) : (
          <span className="text-ink-2">{display}</span>
        )
      ) : (
        <span className="text-ink-4">—</span>
      )}
    </div>
  );
}
