import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser } from "../_lib/auth.js";
import { getFile } from "../_lib/db.js";
import { renderFile } from "../_lib/files.js";

// GET /f/:id[?t=shareToken]  (rewritten to /api/router?path=file&id=…)
// Renders a File as a standalone page. Public files open with their share
// token; otherwise a parent session is required.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  const t = typeof req.query.t === "string" ? req.query.t : "";
  const doc = id ? await getFile(id) : null;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // No scripts, ever: file bodies are model-generated markdown.
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:");
  if (!doc) return res.status(404).send("<!doctype html><p style='font-family:system-ui'>No such file.</p>");

  const allowed = (doc.public && doc.shareToken && t === doc.shareToken) || !!(await requireUser(req));
  if (!allowed) {
    return res
      .status(401)
      .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui;padding:24px"><p>This file is private. <a href="/">Log in to Family HQ</a> to view it.</p></body></html>`);
  }
  res.status(200).send(renderFile(doc));
}
