import { LOYALTY_PROGRAMS, findProgram, loyaltyError, loyaltyWarning, normalizeLoyaltyNumber } from "../data/loyalty";

// One row per loyalty account: the program (from the list, or "Other" with a name) and the
// member number, checked as it's typed — a malformed number is an error, an unusual one a warning.

type Row = { program: string; number: string; custom?: boolean };

const KINDS = [
  ["airline", "Airlines"],
  ["hotel", "Hotels"],
  ["car", "Car rental"],
  ["rail", "Rail"],
] as const;

export function LoyaltyEditor({ value, onChange, showErrors }: { value: Row[] | undefined; onChange: (v: Row[]) => void; showErrors?: boolean }) {
  const rows: Row[] = value || [];
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cls = "w-full rounded-xl border border-line bg-fill px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none";
  const taken = (i: number) => new Set(rows.filter((_, j) => j !== i).map((r) => findProgram(r.program)?.id).filter(Boolean));

  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const known = findProgram(r.program);
        const other = r.custom || (!!r.program && !known);
        const err = showErrors || r.number ? loyaltyError(r) : null;
        const warn = !err ? loyaltyWarning(r) : null;
        const used = taken(i);
        return (
          <div key={i} className="rounded-xl bg-surface p-2.5 ring-1 ring-line">
            <div className="flex gap-2">
              <select
                className={cls}
                aria-label="Program"
                value={other ? "__other" : known?.id || ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__other") set(i, { program: "", custom: true });
                  else set(i, { program: LOYALTY_PROGRAMS.find((p) => p.id === v)?.name || "", custom: false });
                }}
              >
                <option value="">Choose a program…</option>
                {KINDS.map(([k, label]) => (
                  <optgroup key={k} label={label}>
                    {LOYALTY_PROGRAMS.filter((p) => p.kind === k).map((p) => (
                      <option key={p.id} value={p.id} disabled={used.has(p.id)}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value="__other">Other…</option>
              </select>
              <button type="button" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="min-h-[44px] shrink-0 rounded-xl px-3 text-ink-3 active:bg-fill">
                ✕
              </button>
            </div>
            {other && <input className={`${cls} mt-2`} placeholder="Program name" value={r.program} onChange={(e) => set(i, { program: e.target.value, custom: true })} />}
            <input
              className={`${cls} mt-2 font-mono tracking-wide ${err ? "border-danger" : ""}`}
              placeholder={known?.hint ? `Member number — ${known.hint}` : "Member number"}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              value={r.number}
              onChange={(e) => set(i, { number: e.target.value })}
              onBlur={() => r.number && set(i, { number: normalizeLoyaltyNumber(r.number) })}
            />
            {err && <div className="mt-1 text-xs text-danger">{err}</div>}
            {warn && <div className="mt-1 text-xs text-warn">{warn}</div>}
          </div>
        );
      })}
      <button type="button" onClick={() => onChange([...rows, { program: "", number: "" }])} className="min-h-[40px] text-sm font-semibold text-accent">
        + Add a program
      </button>
    </div>
  );
}
