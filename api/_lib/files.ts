import { randomBytes } from "node:crypto";
import { marked } from "marked";
import { getFile, saveFile, addAudit } from "./db.js";
import type { FileDoc } from "../../src/data/types";

// Files: rendered pages the assistant produces (comparisons, plans, itineraries).
// Private by default (login required); a share token makes one publicly viewable.

export async function createFile(input: { title: string; markdown: string; taskId?: string; privateTo?: "alex" | "sam" }): Promise<FileDoc> {
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
  };
  await saveFile(doc);
  await addAudit({ kind: "file_created", summary: `File: ${doc.title}`, by: "agent", ref: doc.id });
  return doc;
}

export async function setFilePublic(id: string, isPublic: boolean, by: string): Promise<FileDoc | null> {
  const doc = await getFile(id);
  if (!doc) return null;
  doc.public = isPublic;
  if (isPublic && !doc.shareToken) doc.shareToken = randomBytes(12).toString("base64url");
  await saveFile(doc);
  await addAudit({ kind: isPublic ? "file_shared" : "file_unshared", summary: `File: ${doc.title}`, by, ref: doc.id });
  return doc;
}

/** In-app (private) URL, or the public share URL when shared. */
export function fileUrl(doc: FileDoc, origin = "https://your-app.vercel.app"): string {
  return doc.public && doc.shareToken ? `${origin}/f/${doc.id}?t=${doc.shareToken}` : `${origin}/f/${doc.id}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Render a file to a standalone HTML page. Served with a no-script CSP. */
export function renderFile(doc: FileDoc): string {
  const body = marked.parse(doc.markdown, { async: false }) as string;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)} — Family HQ</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px 16px}
main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px 22px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:22px 0 8px}h3{font-size:15px;margin:18px 0 6px}
p,li{font-size:15px;line-height:1.55}table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0}
th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f1f5f9}
code{background:#f1f5f9;padding:1px 4px;border-radius:4px}a{color:#2563eb}
.meta{color:#64748b;font-size:12px;margin-bottom:14px}
</style></head><body><main>
<div class="meta">🏡 Family HQ · ${doc.public ? "Shared" : "Private"} · ${new Date(doc.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
<h1>${esc(doc.title)}</h1>
${body}
</main></body></html>`;
}
