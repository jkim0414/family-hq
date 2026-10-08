import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getProfile, setProfile } from "../_lib/db.js";
import { canSee } from "../_lib/privacy.js";
import { json } from "../_lib/http.js";
import { isFactTopic, newFactId } from "../../src/data/facts.js";
import { requireParent } from "../_lib/auth.js";

// POST /api/profile  { profile: {facts, people} }  — replace the household profile (a parent).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  const user = await requireParent(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const profile = body?.profile;
    if (!profile || !Array.isArray(profile.facts) || !Array.isArray(profile.people)) {
      return json(res, 400, { error: "invalid profile" });
    }
    const facts = profile.facts
      .filter((f: any) => f && typeof f.text === "string" && f.text.trim())
      .map((f: any) => ({ id: String(f.id || newFactId()), topic: isFactTopic(f.topic) ? f.topic : "other", text: f.text.trim().slice(0, 600), updatedAt: String(f.updatedAt || new Date().toISOString()), ...(Array.isArray(f.about) && f.about.length ? { about: f.about.map(String) } : {}) }));
    // Who a fact is kept for is set where it was said, not by the editor: keep each fact's audience,
    // and keep the facts this parent can't see (kept in a chat they're not in) untouched.
    const prior = (await getProfile()).facts;
    const audienceOf = new Map(prior.filter((f) => f.audience).map((f) => [f.id, f.audience!]));
    const hidden = prior.filter((f) => !canSee(f, user.id));
    const edited = facts
      .filter((f: { id: string }) => !hidden.some((h) => h.id === f.id))
      .map((f: { id: string }) => (audienceOf.has(f.id) ? { ...f, audience: audienceOf.get(f.id) } : f));
    await setProfile({ facts: [...edited, ...hidden], people: profile.people });
    json(res, 200, { ok: true });
  } catch (err) {
    console.error("profile save failed", err);
    json(res, 500, { error: "Couldn't save." });
  }
}
