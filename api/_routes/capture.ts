import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { runCapture } from "../_lib/capture.js";

// POST /api/capture  { text, images?, silent? }  — file a note / photo / PDF.
// (The app's chat composer uses this for attachments; kept as its own endpoint
// for scripts and tests.)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!(await requireUser(req))) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const text = (body?.text || "").trim();
    const images = Array.isArray(body?.images) ? body.images : [];
    if (!text && images.length === 0) return json(res, 400, { error: "text or attachment required" });
    json(res, 200, await runCapture({ text, images, silent: body?.silent === true }));
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err) });
  }
}
