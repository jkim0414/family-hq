import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { decideAction, actionScreenshot } from "../_lib/actions.js";
import { getCollection } from "../_lib/db.js";
import { isParent, canSeeArtifact } from "../_lib/privacy.js";

// POST /api/action  { id, decision: "approve" | "decline" }
// GET  /api/action?id=…&shot=1 → the page screenshot attached to a browser-step approval (JPEG)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && typeof req.query.id === "string") {
    const a = (await getCollection("actions")).find((x) => x.id === req.query.id);
    if (!a || !canSeeArtifact(a, user.id)) return json(res, 404, { error: "no screenshot" });
    const shot = await actionScreenshot(a);
    if (!shot) return json(res, 404, { error: "no screenshot" });
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("cache-control", "private, max-age=86400, immutable");
    return res.status(200).send(Buffer.from(shot, "base64"));
  }
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { id, decision } = body || {};
    if (!id || (decision !== "approve" && decision !== "decline")) return json(res, 400, { error: "id and decision required" });
    // Only a parent decides (a caregiver's requests wait for one of them).
    if (!isParent(user.id)) return json(res, 403, { error: "only a parent can approve" });
    const action = await decideAction(String(id), decision, user.id);
    json(res, 200, { ok: true, action });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
