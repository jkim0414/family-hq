import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setProfile } from "../_lib/db.js";
import { json } from "../_lib/http.js";
import { isFactTopic, newFactId } from "../../src/data/facts.js";
import { requireParent } from "../_lib/auth.js";

// POST /api/profile  { profile: {facts, people} }  — replace the household profile (a parent).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!(await requireParent(req))) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const profile = body?.profile;
    if (!profile || !Array.isArray(profile.facts) || !Array.isArray(profile.people)) {
      return json(res, 400, { error: "invalid profile" });
    }
    const facts = profile.facts
      .filter((f: any) => f && typeof f.text === "string" && f.text.trim())
      .map((f: any) => ({ id: String(f.id || newFactId()), topic: isFactTopic(f.topic) ? f.topic : "other", text: f.text.trim().slice(0, 600), updatedAt: String(f.updatedAt || new Date().toISOString()), ...(Array.isArray(f.about) && f.about.length ? { about: f.about.map(String) } : {}) }));
    await setProfile({ facts, people: profile.people });
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
