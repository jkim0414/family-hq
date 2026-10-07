import { useEffect, useState } from "react";
import { Card, Collapsible } from "./ui";
import { EntityForm, type FieldDef } from "./EntityForm";
import { personName, personColor } from "../data/people";
import type { Traveler } from "../data/types";

// Everyone's travel card: what Kimi needs to book a trip — legal name, birthday, seat, loyalty
// numbers, and (stored encrypted, shown as last four) passport and Known Traveler numbers.
// A parent sees and edits everyone's; Grandma, her own.

const SEX = [
  { value: "", label: "—" },
  { value: "F", label: "Female" },
  { value: "M", label: "Male" },
  { value: "X", label: "Unspecified (X)" },
];
const SEAT = [
  { value: "", label: "No preference" },
  { value: "window", label: "Window" },
  { value: "aisle", label: "Aisle" },
];

const fieldsFor = (t: Traveler, vault: boolean): FieldDef[] => [
  { key: "firstName", label: "First name (as on ID)" },
  { key: "middleName", label: "Middle name" },
  { key: "lastName", label: "Last name" },
  { key: "dob", label: "Date of birth", type: "date" },
  { key: "gender", label: "Gender (as on ID)", type: "select", options: SEX },
  { key: "seat", label: "Seat", type: "select", options: SEAT },
  { key: "loyalty", label: "Loyalty programs", type: "loyalty" },
  ...(vault
    ? ([
        { key: "ktn", label: "Known Traveler Number (TSA PreCheck)", type: "secret", placeholder: t.ktn ? `On file (…${t.ktn.last4}) — type to replace` : "Optional" },
        { key: "clearKtn", label: "", type: "checkbox", placeholder: "Remove the Known Traveler Number", showIf: () => !!t.ktn },
        { key: "passportNumber", label: "Passport number", type: "secret", placeholder: t.passport ? `On file (…${t.passport.last4}) — type to replace` : "Optional" },
        { key: "clearPassport", label: "", type: "checkbox", placeholder: "Remove the passport", showIf: () => !!t.passport },
        { key: "passportCountry", label: "Passport country", placeholder: "USA", showIf: (f) => !!t.passport || !!f.passportNumber },
        { key: "passportExpires", label: "Passport expires", type: "date", showIf: (f) => !!t.passport || !!f.passportNumber },
      ] as FieldDef[])
    : []),
  { key: "notes", label: "Notes", type: "textarea", placeholder: "Exit row, needs a car seat, TSA notes…" },
];

export function TravelCards() {
  const [list, setList] = useState<Traveler[] | null>(null);
  const [vault, setVault] = useState(true);
  const [edit, setEdit] = useState<Traveler | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const r = await fetch("/api/travelers", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setList(j.travelers || []);
      setVault(!!j.vault);
    } catch {
      /* offline */
    }
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (v: Record<string, any>) => {
    const t = edit!;
    const body: Record<string, unknown> = {
      id: t.id,
      firstName: v.firstName || "",
      middleName: v.middleName || "",
      lastName: v.lastName || "",
      dob: v.dob || "",
      gender: v.gender || "",
      seat: v.seat || "",
      notes: v.notes || "",
      loyalty: (v.loyalty || []).filter((l: { program: string; number: string }) => l.program?.trim() || l.number?.trim()).map((l: { program: string; number: string }) => ({ program: l.program, number: l.number })),
    };
    if (v.clearKtn) body.ktn = null;
    else if (v.ktn) body.ktn = v.ktn;
    if (v.clearPassport) body.passportNumber = null;
    else if (v.passportNumber) body.passportNumber = v.passportNumber;
    if (!v.clearPassport && (t.passport || v.passportNumber)) {
      body.passportCountry = v.passportCountry || "";
      body.passportExpires = v.passportExpires || "";
    }
    setError("");
    const r = await fetch("/api/travelers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(j.error || "Couldn't save — try again.");
      return;
    }
    setEdit(null);
    load();
  };

  if (!list) return null;
  return (
    <>
      <Collapsible id="travel" title="Travel" count={list.length} defaultOpen={false} hint="What Kimi needs to book a trip. Passport and Known Traveler numbers are stored encrypted; Kimi enters them on booking sites without seeing them.">
        <Card className="divide-y divide-line">
          {list.map((t) => {
            const name = [t.firstName, t.middleName, t.lastName].filter(Boolean).join(" ");
            const bits = [
              t.loyalty.map((l) => `${l.program} ${l.number}`).join(" · "),
              t.ktn ? `PreCheck …${t.ktn.last4}` : "",
              t.passport ? `Passport …${t.passport.last4}${t.passport.expires ? ` (exp ${t.passport.expires})` : ""}` : "",
            ].filter(Boolean);
            return (
              <button key={t.id} type="button" className="block w-full px-4 py-3 text-left" onClick={() => setEdit(t)}>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: personColor(t.id) }} />
                  <span className="text-sm font-semibold text-ink">{personName(t.id)}</span>
                  {name && <span className="truncate text-xs text-ink-3">{name}</span>}
                </div>
                <div className="mt-0.5 break-words text-xs text-ink-3">{bits.length ? bits.join(" · ") : "Nothing on file yet — tap to add"}</div>
              </button>
            );
          })}
        </Card>
      </Collapsible>
      {edit && (
        <EntityForm
          title={`${personName(edit.id)}'s travel card`}
          fields={fieldsFor(edit, vault)}
          value={{ ...edit, loyalty: edit.loyalty.map((l) => ({ ...l })), ktn: "", passportNumber: "", passportCountry: edit.passport?.country || "", passportExpires: edit.passport?.expires || "" }}
          onSave={save}
          onClose={() => {
            setEdit(null);
            setError("");
          }}
        />
      )}
      {error && <div className="fixed inset-x-0 bottom-24 z-[60] mx-auto w-fit rounded-full bg-danger px-4 py-2 text-sm text-surface">{error}</div>}
    </>
  );
}
