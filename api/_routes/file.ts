import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser } from "../_lib/auth.js";
import { getFile, redis } from "../_lib/db.js";
import { renderFile } from "../_lib/files.js";
import { canSeeArtifact } from "../_lib/privacy.js";
import { sameSecret } from "../_lib/http.js";

// GET /f/:id[?t=shareToken]  (rewritten to /api/router?path=file&id=…)
// Renders a File as a standalone page. Public files open with their share
// token; otherwise a parent session is required.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  const t = typeof req.query.t === "string" ? req.query.t : "";
  let doc = id ? await getFile(id) : null;
  // Versions that used to be separate files ("… v2") now live in one; old links follow.
  if (!doc && id) {
    const moved = await redis.get<string>(`file_moved:${id}`);
    if (moved) return res.redirect(302, `/f/${moved}${t ? `?t=${encodeURIComponent(t)}` : ""}`);
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // No scripts, ever: file bodies are model-generated markdown.
  // Images only from this site (an outside image is a way to report that the page was opened).
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader("referrer-policy", "no-referrer");
  if (!doc) return res.status(404).send("<!doctype html><p style='font-family:system-ui'>No such file.</p>");

  // A shared link opens for anyone; otherwise a signed-in parent — and a private file only for its owner.
  const viewer = await requireUser(req);
  const member = !!viewer && canSeeArtifact(doc, viewer.id);
  const allowed = member || (doc.public && doc.shareToken && sameSecret(t, doc.shareToken));
  if (!allowed) {
    return res
      .status(401)
      .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui;padding:24px"><p>This file is private. <a href="/">Log in to Family HQ</a> to view it.</p></body></html>`);
  }
  // Earlier versions are for the family; a shared link shows the current one.
  const v = member ? Number(req.query.v) || undefined : undefined;
  res.status(200).send(renderFile(member ? doc : { ...doc, versions: [] }, { version: v, token: t || undefined }));
}
