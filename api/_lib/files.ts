import { randomBytes } from "node:crypto";
import { Marked } from "marked";

// File bodies are model-written markdown (and the model reads emails and web pages): render it with
// raw HTML shown as text, and only web/mail/phone links — no forms, redirects, or script URLs.
const md = new Marked({
  renderer: {
    html({ text }) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  },
  walkTokens(token) {
    if ((token.type === "link" || token.type === "image") && !/^(https?:|mailto:|tel:|\/|#)/i.test(token.href)) token.href = "#";
  },
});
import { getFile, saveFile, addAudit } from "./db.js";
import type { FileDoc, Member } from "../../src/data/types";

// Files: rendered pages the assistant produces (comparisons, plans, itineraries).
// Private by default (login required); a share token makes one publicly viewable.

export async function createFile(input: { title: string; markdown: string; taskId?: string; privateTo?: Member; audience?: Member[]; thread?: string; eventId?: string }): Promise<FileDoc> {
  const now = new Date().toISOString();
  const doc: FileDoc = {
    id: `f-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    title: input.title.trim() || "Untitled",
    markdown: input.markdown,
    createdAt: now,
    updatedAt: now,
    public: false,
    taskId: input.taskId,
    privateTo: input.privateTo,
    audience: input.audience,
    thread: input.thread,
    eventId: input.eventId,
  };
  await saveFile(doc);
  // The log entry is as private as the file (its title alone can give a surprise away).
  await addAudit({ kind: "file_created", summary: `File: ${doc.title}`, by: "agent", ref: doc.id, privateTo: doc.privateTo, audience: doc.audience });
  return doc;
}

const MAX_VERSIONS = 10;

/** A new version of a file: same id and link; the previous version is kept in its history. */
export async function updateFile(id: string, input: { title?: string; markdown: string; eventId?: string }): Promise<FileDoc | null> {
  const doc = await getFile(id);
  if (!doc) return null;
  const now = new Date().toISOString();
  doc.versions = [...(doc.versions || []), { title: doc.title, markdown: doc.markdown, updatedAt: doc.updatedAt }].slice(-MAX_VERSIONS);
  doc.title = input.title?.trim() || doc.title;
  doc.markdown = input.markdown;
  doc.updatedAt = now;
  if (input.eventId) doc.eventId = input.eventId;
  await saveFile(doc);
  await addAudit({ kind: "file_updated", summary: `File updated: ${doc.title}`, by: "agent", ref: doc.id, privateTo: doc.privateTo, audience: doc.audience });
  return doc;
}

export async function setFilePublic(id: string, isPublic: boolean, by: string): Promise<FileDoc | null> {
  const doc = await getFile(id);
  if (!doc) return null;
  doc.public = isPublic;
  // A fresh link each time it's shared: un-sharing really ends the old one.
  if (isPublic) doc.shareToken = randomBytes(16).toString("base64url");
  else delete doc.shareToken;
  await saveFile(doc);
  await addAudit({ kind: isPublic ? "file_shared" : "file_unshared", summary: `File: ${doc.title}`, by, ref: doc.id, privateTo: doc.privateTo, audience: doc.audience });
  return doc;
}

/** In-app (private) URL, or the public share URL when shared. */
export function fileUrl(doc: FileDoc, origin = "https://your-app.vercel.app"): string {
  return doc.public && doc.shareToken ? `${origin}/f/${doc.id}?t=${doc.shareToken}` : `${origin}/f/${doc.id}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Render a file (or one of its earlier versions, 1 = oldest) as a standalone page. Served with a no-script CSP. */
export function renderFile(doc: FileDoc, opts: { version?: number; token?: string } = {}): string {
  const versions = doc.versions || [];
  const old = opts.version && versions[opts.version - 1];
  const shown = old ? { ...doc, title: old.title, markdown: old.markdown, updatedAt: old.updatedAt } : doc;
  const body = md.parse(shown.markdown, { async: false }) as string;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const link = (v?: number) => `/f/${doc.id}?${[v ? `v=${v}` : "", opts.token ? `t=${encodeURIComponent(opts.token)}` : ""].filter(Boolean).join("&")}`;
  const history = versions.length
    ? `<div class="meta">${old ? `Earlier version (${day(shown.updatedAt)}) · <a href="${link()}">see the latest</a>` : `Updated ${day(doc.updatedAt)}`} · versions: ${versions
        .map((v, i) => `<a href="${link(i + 1)}">${day(v.updatedAt)}</a>`)
        .join(", ")}</div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(shown.title)} — Family HQ</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px 16px}
main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px 22px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:22px 0 8px}h3{font-size:15px;margin:18px 0 6px}
p,li{font-size:15px;line-height:1.55}table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0}
th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f1f5f9}
code{background:#f1f5f9;padding:1px 4px;border-radius:4px}a{color:#2563eb}
.meta{color:#64748b;font-size:12px;margin-bottom:14px}
</style></head><body><main>
<div class="meta">🏡 Family HQ · ${doc.public ? "Shared" : "Private"} · ${day(doc.createdAt)}</div>
${history}
<h1>${esc(shown.title)}</h1>
${body}
</main></body></html>`;
}
