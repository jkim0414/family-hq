import { useEffect, useState } from "react";
import { useData } from "../dataStore";
import { fmtDateTime, fmtDate, SOURCE_LABEL } from "../store";
import { Card, Collapsible, CategoryBadge, SourceBadge, CATEGORY_LABEL, TextAction, WhoChips } from "./ui";
import { peopleOf, ownerOf } from "../data/people";
import type { Comm, AuditEntry } from "../data/types";

// One timeline: what came in (forwarded mail, photos, mirrored calendar items)
// and what Kimi did (drafts, approvals, files). Newest first.

type Row = { kind: "comm"; at: string; c: Comm } | { kind: "audit"; at: string; e: AuditEntry };

const AUDIT_ICON: Record<string, string> = {
  proposed: "📝",
  approved: "✅",
  executed: "✅",
  declined: "🚫",
  failed: "⚠️",
  file_created: "📄",
  file_shared: "🔗",
  file_unshared: "🔒",
  vault: "🔑",
};

const PAGE = 25;

export function History() {
  const { data } = useData();
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [filter, setFilter] = useState<"all" | "in" | "did">("all");

  const rows: Row[] = [
    ...data.comms.map((c): Row => ({ kind: "comm", at: c.receivedAt, c })),
    ...(data.audit || []).map((e): Row => ({ kind: "audit", at: e.at, e })),
  ]
    .filter((r) => filter === "all" || (filter === "in" ? r.kind === "comm" : r.kind === "audit"))
    .sort((a, b) => b.at.localeCompare(a.at));

  return (
    <Collapsible id="history" title="History" defaultOpen={false} hint="What came in, and what Kimi did.">
      <div className="mb-2 flex gap-2" role="tablist" aria-label="Filter">
        {(
          [
            ["all", "All"],
            ["in", "Came in"],
            ["did", "Kimi did"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={filter === k}
            onClick={() => setFilter(k)}
            className={`min-h-[36px] rounded-full px-3 text-xs font-medium ${filter === k ? "bg-ink text-surface" : "bg-surface text-ink-2 ring-1 ring-line"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-3">Nothing yet.</div>
      ) : (
        <Card className="divide-y divide-line">
          {rows.slice(0, limit).map((r) =>
            r.kind === "audit" ? (
              <div key={`a-${r.e.id}`} className="flex gap-2 px-4 py-2 text-xs">
                <span className="shrink-0">{AUDIT_ICON[r.e.kind] || "•"}</span>
                <span className="min-w-0 flex-1 break-words text-ink-2">{r.e.summary}</span>
                <span className="shrink-0 text-ink-3">{fmtDateTime(r.e.at)}</span>
              </div>
            ) : (
              <div key={`c-${r.c.id}`} className="px-4 py-3">
                <button type="button" className="w-full text-left" aria-expanded={open === r.c.id} onClick={() => setOpen(open === r.c.id ? null : r.c.id)}>
                  <div className="flex items-center gap-2">
                    <CategoryBadge category={r.c.category} />
                    {(SOURCE_LABEL[r.c.source] || r.c.source) !== CATEGORY_LABEL(r.c.category) && <SourceBadge source={r.c.source} />}
                    <span className="ml-auto text-xs text-ink-3">{r.c.source === "calendar" ? fmtDate(r.c.receivedAt.slice(0, 10)) : fmtDateTime(r.c.receivedAt)}</span>
                  </div>
                  <div className="mt-1 break-words text-sm font-semibold text-ink">{r.c.subject}</div>
                  {(r.c.mailbox === "alex" || r.c.mailbox === "sam") && <div className="text-[11px] text-ink-3">via {r.c.mailbox === "alex" ? "Alex" : "Sam"}'s Gmail</div>}
                  <div className="break-words text-sm text-ink-2">{r.c.summary}</div>
                  <div className="mt-1.5">
                    <WhoChips people={peopleOf(r.c)} owner={ownerOf(r.c)} />
                  </div>
                </button>
                {open === r.c.id && (
                  <div className="mt-3 space-y-2 border-t border-line pt-3">
                    {r.c.reason && (
                      <div className="rounded-lg bg-fill p-2 text-xs text-ink-3 [overflow-wrap:anywhere]">
                        <span className="font-semibold text-ink-2">Why {r.c.category}:</span> {r.c.reason}
                      </div>
                    )}
                    {(r.c.raw || r.c.hasRaw) && <RawText id={r.c.id} initial={r.c.raw} />}
                  </div>
                )}
              </div>
            )
          )}
          {rows.length > limit && (
            <div className="px-4 py-2 text-center">
              <TextAction onClick={() => setLimit((l) => l + PAGE)}>Show more</TextAction>
            </div>
          )}
        </Card>
      )}
    </Collapsible>
  );
}

/** The original message text, fetched when a row is expanded (it's left out of the app state to keep it small). */
function RawText({ id, initial }: { id: string; initial?: string }) {
  const [raw, setRaw] = useState<string | null>(initial ?? null);
  useEffect(() => {
    if (raw !== null) return;
    let live = true;
    fetch(`/api/data?comm=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { raw: "" }))
      .then((j) => live && setRaw(j.raw || ""))
      .catch(() => live && setRaw(""));
    return () => {
      live = false;
    };
  }, [id, raw]);
  if (raw === null) return <div className="text-xs text-ink-3">Loading…</div>;
  if (!raw) return null;
  return <div className="whitespace-pre-wrap rounded-lg bg-fill p-2 text-xs text-ink-2 [overflow-wrap:anywhere]">{raw}</div>;
}
