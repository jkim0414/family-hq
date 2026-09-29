import { useEffect, useState } from "react";
import { fmtDateTime } from "../store";
import { Card, Collapsible, TextAction } from "./ui";

export interface FileRow {
  id: string;
  title: string;
  createdAt: string;
  public: boolean;
  url: string;
}

// Pages the assistant produced (comparisons, plans, itineraries). Private
// unless shared; sharing mints a link anyone can open.
export function FilesList() {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const r = await fetch(`/api/files?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        setFiles((await r.json()).files || []);
        setLoaded(true);
      }
    } catch {
      /* offline */
    }
  };
  useEffect(() => {
    load();
  }, []);

  const toggleShare = async (f: FileRow) => {
    const r = await fetch("/api/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: f.id, public: !f.public }) });
    if (r.ok) load();
  };
  const copy = async (f: FileRow) => {
    try {
      await navigator.clipboard.writeText(f.url);
      setCopied(f.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <Collapsible id="files" title="Files" count={loaded ? files.length : undefined} defaultOpen={false} hint="Pages Kimi wrote — comparisons, plans, itineraries.">
      {!loaded ? (
        <div className="text-sm text-ink-3">Loading…</div>
      ) : files.length === 0 ? (
        <div className="text-sm text-ink-3">No files yet. Ask Kimi for a comparison or a plan in Chat and she'll make one.</div>
      ) : (
        <Card className="divide-y divide-line">
          {files.map((f) => (
            <div key={f.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 break-words text-sm font-semibold text-accent">
                  📄 {f.title}
                </a>
                <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${f.public ? "bg-ok-soft text-ok" : "bg-fill text-ink-3"}`}>
                  {f.public ? "Shared" : "Private"}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-ink-3">
                <span className="mr-1">{fmtDateTime(f.createdAt)}</span>
                <TextAction onClick={() => toggleShare(f)}>{f.public ? "Make private" : "Share link"}</TextAction>
                {f.public && <TextAction onClick={() => copy(f)}>{copied === f.id ? "Copied ✓" : "Copy link"}</TextAction>}
              </div>
            </div>
          ))}
        </Card>
      )}
    </Collapsible>
  );
}
