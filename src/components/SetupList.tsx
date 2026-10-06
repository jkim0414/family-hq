import { useEffect, useState } from "react";
import { Card, Collapsible } from "./ui";

// What's set up, for whoever runs this app — each connector on/off, with a link to its section
// of the setup guide. Useful after forking: optional features stay off until their keys are set.
const GUIDE = "https://github.com/jkim0414/family-hq/blob/main/SETUP.md";

type Item = { id: string; label: string; what: string; required?: boolean; on: boolean; status?: string; guide: string };

export function SetupList() {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    fetch("/api/setup", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setItems(j?.items || []))
      .catch(() => setItems([]));
  }, []);
  if (!items || !items.length) return null;
  const on = items.filter((i) => i.on).length;
  const missingRequired = items.some((i) => i.required && !i.on);

  return (
    <Collapsible id="setup" title="Setup" defaultOpen={missingRequired} hint={`${on} of ${items.length} set up. Optional pieces stay off until their keys are set.`}>
      <Card className="divide-y divide-line">
        {items.map((i) => (
          <div key={i.id} className="flex items-start gap-3 px-4 py-3">
            <span aria-hidden className={`mt-0.5 text-[15px] leading-none ${i.on ? "text-ok" : "text-ink-3"}`}>
              {i.on ? "✓" : "○"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] text-ink">
                {i.label}
                {i.required && !i.on && <span className="ml-1.5 rounded bg-danger-soft px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-danger">Required</span>}
              </div>
              <div className="text-xs text-ink-3">{i.what}</div>
              {i.status && <div className="text-xs text-ink-2">{i.status}</div>}
            </div>
            {!i.on && (
              <a href={`${GUIDE}#${i.guide}`} target="_blank" rel="noreferrer" className="shrink-0 pt-0.5 text-xs font-semibold text-accent">
                How to set up
              </a>
            )}
          </div>
        ))}
      </Card>
    </Collapsible>
  );
}
