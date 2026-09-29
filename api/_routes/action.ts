import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { decideAction } from "../_lib/actions.js";
import { getCollection } from "../_lib/db.js";

// POST /api/action  { id, decision: "approve" | "decline" }
// GET  /api/action?id=…&shot=1 → the page screenshot attached to a browser-step approval (JPEG)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && typeof req.query.id === "string") {
    const a = (await getCollection("actions")).find((x) => x.id === req.query.id);
    const shot = (a?.payload as { screenshot?: string } | undefined)?.screenshot;
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
    const action = await decideAction(String(id), decision, user.id);
    json(res, 200, { ok: true, action });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
