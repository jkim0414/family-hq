import { useState } from "react";
import { useData } from "../dataStore";
import { describe } from "../data/schedule";
import { Card, Collapsible, TextAction, PrivateTag } from "./ui";

// Scheduled and recurring tasks Kimi will run ("every last day of the month…"),
// with who gets the result and a way to cancel. Set up by asking Kimi in Chat.
export function ScheduledList() {
  const { data, refresh } = useData();
  const [cancelled, setCancelled] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = (data.schedules || [])
    .filter((s) => s.active && !cancelled.includes(s.id))
    .sort((a, b) => (a.nextRunAt || "").localeCompare(b.nextRunAt || ""));

  const cancel = async (id: string, title: string) => {
    if (!confirm(`Cancel "${title}"?`)) return;
    setBusy(id);
    try {
      const r = await fetch("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, cancel: true }) });
      if (r.ok) setCancelled((c) => [...c, id]);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Collapsible id="scheduled" title="Scheduled" count={rows.length} defaultOpen={false} hint="Things Kimi will do at a set time, once or on a repeat. Ask her in Chat to add one.">
      {rows.length === 0 ? (
        <div className="text-sm text-ink-3">Nothing scheduled. Try “every last day of the month, recap our spending” or “check on the soccer sign-up next Tuesday.”</div>
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((s) => (
            <div key={s.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-sm font-semibold text-ink">{s.title}{s.privateTo && <PrivateTag className="ml-1.5" />}</div>
                <TextAction onClick={() => cancel(s.id, s.title)} disabled={busy === s.id}>
                  {busy === s.id ? "Cancelling…" : "Cancel"}
                </TextAction>
              </div>
              <div className="mt-0.5 text-xs text-ink-2">{describe(s)}</div>
              <div className="mt-0.5 text-xs text-ink-3">
                Next:{" "}
                {s.nextRunAt
                  ? new Date(s.nextRunAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                  : "—"}{" "}
                · for {s.notify === "both" ? "Alex & Sam" : s.owner === "alex" ? "Alex" : "Sam"}
              </div>
            </div>
          ))}
        </Card>
      )}
    </Collapsible>
  );
}
