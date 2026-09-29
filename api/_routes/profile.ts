import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setProfile } from "../_lib/db.js";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";

// POST /api/profile  { profile }  — replace the household profile.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!(await requireUser(req))) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const profile = body?.profile;
    if (!profile || !Array.isArray(profile.sections) || !Array.isArray(profile.people)) {
      return json(res, 400, { error: "invalid profile" });
    }
    await setProfile(profile);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
