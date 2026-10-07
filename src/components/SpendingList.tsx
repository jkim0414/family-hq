import { SPEND_CATEGORIES } from "../data/spending";
import { useMemo, useState } from "react";
import { useData } from "../dataStore";
import { fmtDate } from "../store";
import { Card, Collapsible, TextAction, PrivateTag } from "./ui";

const money = (n: number, cur = "USD") => {
  try {
    return n.toLocaleString("en-US", { style: "currency", currency: cur });
  } catch {
    return `${cur} ${n.toFixed(2)}`;
  }
};

const catLabel = (c: string) => (SPEND_CATEGORIES.find((x) => x.id === c)?.label || c).replace(/:.*$/, "");

// The spending log: purchases from order/payment receipts in both parents' inboxes,
// with the ones Kimi placed marked. A view of receipts — not a bank statement.
export function SpendingList() {
  const { data } = useData();
  const [all, setAll] = useState(false);
  const rows = data.spending || [];
  const month = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }).slice(0, 7);
  const [cat, setCat] = useState<string | null>(null);
  const { monthTotal, kimiTotal, monthCount, byCat } = useMemo(() => {
    const m = rows.filter((r) => r.date.startsWith(month) && r.currency === "USD");
    const totals = new Map<string, number>();
    for (const r of m) totals.set(r.category || "other", (totals.get(r.category || "other") || 0) + r.amount);
    return {
      monthTotal: m.reduce((a, r) => a + r.amount, 0),
      kimiTotal: m.filter((r) => r.byKimi).reduce((a, r) => a + r.amount, 0),
      monthCount: m.length,
      byCat: [...totals.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [rows, month]);
  const filtered = cat ? rows.filter((r) => (r.category || "other") === cat) : rows;
  const shown = all ? filtered : filtered.slice(0, 25);

  return (
    <Collapsible id="spending" title="Spending" count={monthCount} defaultOpen={false} hint="Purchases from receipts in your inboxes, including anything Kimi bought. Not a bank statement.">
      {rows.length === 0 ? (
        <div className="text-sm text-ink-3">No receipts yet. Kimi adds them as order and payment confirmations arrive.</div>
      ) : (
        <div className="space-y-2">
          <div className="px-1 text-[13px] text-ink-2">
            This month: <span className="font-semibold text-ink">{money(monthTotal)}</span> across {monthCount} purchase{monthCount === 1 ? "" : "s"}
            {kimiTotal > 0 && <> · Kimi placed {money(kimiTotal)}</>}
          </div>
          {byCat.length > 1 && (
            <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
              {byCat.map(([c, v]) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCat((x) => (x === c ? null : c))}
                  className={`min-h-[32px] shrink-0 rounded-full px-3 text-xs font-medium ${cat === c ? "bg-ink text-surface" : "bg-fill text-ink-2"}`}
                >
                  {catLabel(c)} {money(v)}
                </button>
              ))}
            </div>
          )}
          <Card className="divide-y divide-line">
            {shown.map((r) => (
              <div key={r.id} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold text-ink">{r.merchant}</span>
                  <span className="shrink-0 text-sm tabular-nums text-ink">{money(r.amount, r.currency)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
                  <span>{fmtDate(r.date)}</span>
                  {r.description && <span className="min-w-0 truncate">· {r.description}</span>}
                  <span>· {r.account === "alex" ? "Alex" : "Sam"}</span>
                  {r.cardLast4 && <span>· …{r.cardLast4}</span>}
                  {r.byKimi && <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">Kimi</span>}
                  {r.privateTo && <PrivateTag />}
                </div>
              </div>
            ))}
          </Card>
          {filtered.length > 25 && (
            <div className="px-1">
              <TextAction onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${filtered.length}`}</TextAction>
            </div>
          )}
        </div>
      )}
    </Collapsible>
  );
}
