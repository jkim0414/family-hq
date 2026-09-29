import { useEffect, useState } from "react";
import { KIDS, formatPhone } from "../store";
import { PEOPLE } from "../data/people";
import { Button } from "./ui";
import type { KidId } from "../data/types";

export type FieldType =
  | "text"
  | "textarea"
  | "date"
  | "time"
  | "select"
  | "kids"
  | "people"
  | "checkbox"
  | "email"
  | "phone"
  | "url";

export interface FieldDef {
  key: string;
  label: string;
  type?: FieldType;
  options?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  /** Hide the field unless this returns true for the current form values. */
  showIf?: (form: Record<string, any>) => boolean;
}

// ── Validation ───────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function digits(s: string) {
  return (s.match(/\d/g) || []).length;
}

/** Returns an error string, or null if valid. Empty optional fields are valid. */
export function validateField(field: FieldDef, raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : raw;
  const empty = value === "" || value === undefined || value === null;

  if (field.required && empty) return "Required";
  if (empty) return null; // optional + empty → fine

  const s = String(value);
  switch (field.type) {
    case "email":
      return EMAIL_RE.test(s) ? null : "Enter a valid email (name@example.com)";
    case "phone":
      // Allow +, spaces, dashes, parens, dots; need 7–15 digits.
      if (!/^[+\d\s().-]+$/.test(s)) return "Only digits and + ( ) - . allowed";
      if (digits(s) < 7 || digits(s) > 15) return "Enter a valid phone number";
      return null;
    case "url":
      try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        return u.hostname.includes(".") ? null : "Enter a valid URL";
      } catch {
        return "Enter a valid URL (example.com)";
      }
    default:
      return null;
  }
}

// Bottom sheet on phones, centered dialog on wide screens. Escape or tapping
// the backdrop cancels; Delete asks first.
export function EntityForm({
  title,
  fields,
  value,
  onSave,
  onDelete,
  onClose,
}: {
  title: string;
  fields: FieldDef[];
  value: Record<string, any>;
  onSave: (v: Record<string, any>) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Record<string, any>>({ ...value });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const visible = fields.filter((f) => !f.showIf || f.showIf(form));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (k: string, v: any) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: "" } : e)); // clear error as they type
  };

  const handleSave = () => {
    const next: Record<string, string> = {};
    for (const f of visible) {
      const err = validateField(f, form[f.key]);
      if (err) next[f.key] = err;
    }
    setErrors(next);
    if (Object.keys(next).length === 0) {
      // Normalize: trim strings; format phone numbers.
      const cleaned: Record<string, any> = { ...form };
      for (const f of fields) {
        if (typeof cleaned[f.key] === "string") cleaned[f.key] = cleaned[f.key].trim();
        if (f.type === "phone" && cleaned[f.key]) cleaned[f.key] = formatPhone(cleaned[f.key]);
      }
      onSave(cleaned);
    }
  };

  const handleDelete = () => {
    if (!onDelete) return;
    if (confirm(`Delete this? This can't be undone.`)) onDelete();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-5 pb-8 shadow-sheet md:max-h-[85vh] md:rounded-3xl md:pb-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="-mr-2 flex h-10 w-10 items-center justify-center rounded-full text-2xl leading-none text-ink-3 hover:bg-fill">
            ×
          </button>
        </div>

        <div className="space-y-3">
          {visible.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-3">
                {f.label}
                {f.required && <span className="text-danger"> *</span>}
              </label>
              <FieldInput field={f} value={form[f.key]} invalid={!!errors[f.key]} onChange={(v) => set(f.key, v)} />
              {errors[f.key] && <p className="mt-1 text-xs text-danger">{errors[f.key]}</p>}
            </div>
          ))}
        </div>

        <div className="mt-6 flex gap-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button onClick={handleSave} className="flex-[2]">
            Save
          </Button>
        </div>
        {onDelete && (
          <div className="mt-2 text-center">
            <Button variant="danger" size="sm" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  invalid,
  onChange,
}: {
  field: FieldDef;
  value: any;
  invalid?: boolean;
  onChange: (v: any) => void;
}) {
  const [guest, setGuest] = useState("");
  const cls = `w-full rounded-xl border bg-fill px-3 py-2.5 text-sm text-ink focus:outline-none ${
    invalid ? "border-danger focus:border-danger" : "border-line focus:border-accent"
  }`;

  switch (field.type) {
    case "textarea":
      return <textarea className={cls} rows={3} value={value || ""} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <input type="date" className={cls} value={value || ""} onChange={(e) => onChange(e.target.value)} />;
    case "time":
      return <input type="time" className={cls} value={value || ""} onChange={(e) => onChange(e.target.value)} />;
    case "email":
      return <input type="email" inputMode="email" autoCapitalize="off" autoCorrect="off" className={cls} value={value || ""} placeholder={field.placeholder || "name@example.com"} onChange={(e) => onChange(e.target.value)} />;
    case "phone":
      return <input type="tel" inputMode="tel" className={cls} value={value || ""} placeholder={field.placeholder || "(555) 123-4567"} onChange={(e) => onChange(e.target.value)} />;
    case "url":
      return <input type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" className={cls} value={value || ""} placeholder={field.placeholder || "example.com"} onChange={(e) => onChange(e.target.value)} />;
    case "checkbox":
      return (
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" className="h-5 w-5 rounded accent-accent" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {field.placeholder || "Yes"}
        </label>
      );
    case "select":
      return (
        <select className={cls} value={value || ""} onChange={(e) => onChange(e.target.value)}>
          {(field.options || []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "people": {
      const arr: string[] = value || [];
      const guests = arr.filter((id) => !PEOPLE.some((p) => p.id === id));
      const addGuest = () => {
        const g = guest.trim();
        if (g && !arr.includes(g)) onChange([...arr, g]);
        setGuest("");
      };
      return (
        <div>
          <div className="flex flex-wrap gap-2">
            {PEOPLE.map((p) => {
              const on = arr.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(on ? arr.filter((x) => x !== p.id) : [...arr, p.id])}
                  className="min-h-[36px] rounded-full px-3 text-xs font-medium ring-1"
                  style={{ background: on ? `${p.color}1a` : "transparent", color: on ? p.color : "#94a3b8", borderColor: on ? p.color : "#e2e8f0" }}
                >
                  {p.name}
                </button>
              );
            })}
            {guests.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => onChange(arr.filter((x) => x !== g))}
                className="min-h-[36px] rounded-full bg-fill px-3 text-xs font-medium text-ink-2 ring-1 ring-line"
              >
                {g} ✕
              </button>
            ))}
          </div>
          <input
            type="text"
            value={guest}
            placeholder="Add a guest (e.g. Grandma) ↵"
            onChange={(e) => setGuest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addGuest();
              }
            }}
            onBlur={addGuest}
            className="mt-2 w-full rounded-xl border border-line bg-fill px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </div>
      );
    }
    case "kids":
      return (
        <div className="flex flex-wrap gap-2">
          {KIDS.map((k) => {
            const arr: KidId[] = value || [];
            const on = arr.includes(k.id);
            return (
              <button
                key={k.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? arr.filter((x) => x !== k.id) : [...arr, k.id])}
                className="min-h-[36px] rounded-full px-3 text-xs font-medium ring-1"
                style={{ background: on ? `${k.color}1a` : "transparent", color: on ? k.color : "#94a3b8", borderColor: on ? k.color : "#e2e8f0" }}
              >
                {k.firstName}
              </button>
            );
          })}
        </div>
      );
    default:
      return <input type="text" className={cls} value={value || ""} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}
