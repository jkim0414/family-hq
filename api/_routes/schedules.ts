import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { addAudit } from "../_lib/db.js";
import { cancelSchedule } from "../_lib/schedules.js";

// POST /api/schedules { id, cancel: true } — cancel a scheduled / recurring task from the Kimi tab.
// (The list itself comes with /api/data as the "schedules" collection.)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  if (!body.cancel || !body.id) return json(res, 400, { error: "id and cancel required" });
  const r = await cancelSchedule(String(body.id));
  if (!r || r === "ambiguous") return json(res, 404, { error: "no such schedule" });
  await addAudit({ kind: "declined", summary: `Cancelled scheduled task "${r.title}"`, by: user.id });
  json(res, 200, { ok: true });
}
