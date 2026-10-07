import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser, requestOrigin } from "../_lib/auth.js";
import { getFile, listFileIds } from "../_lib/db.js";
import { setFilePublic, fileUrl } from "../_lib/files.js";
import { canSeeArtifact } from "../_lib/privacy.js";

// GET  /api/files                 → list (newest first)
// POST /api/files { id, public }  → toggle sharing
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    const origin = requestOrigin(req);
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const existing = await getFile(String(body?.id || ""));
      if (!existing || !canSeeArtifact(existing, user.id)) return json(res, 404, { error: "not found" });
      const doc = await setFilePublic(String(body?.id || ""), body?.public === true, user.id);
      if (!doc) return json(res, 404, { error: "not found" });
      return json(res, 200, { ok: true, file: { id: doc.id, title: doc.title, public: doc.public, url: fileUrl(doc, origin) } });
    }
    res.setHeader("cache-control", "no-store");
    const ids = await listFileIds();
    const docs = (await Promise.all(ids.map((i) => getFile(i)))).filter((d): d is NonNullable<typeof d> => canSeeArtifact(d, user.id));
    docs.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    json(res, 200, {
      files: docs.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, versions: d.versions?.length || 0, public: d.public, url: fileUrl(d, origin), privateTo: d.privateTo, audience: d.audience, thread: d.thread })),
    });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
