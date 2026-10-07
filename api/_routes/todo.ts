import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getCollection, setCollection } from "../_lib/db.js";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { canSee } from "../_lib/privacy.js";

// POST /api/todo  { id, done }  — toggle a to-do's done state (shared between parents).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { id, done } = body || {};
    if (!id || typeof done !== "boolean") {
      return json(res, 400, { error: "id and done required" });
    }
    const todos = await getCollection("todos");
    const t = todos.find((x) => x.id === id && canSee(x, user.id));
    if (!t) return json(res, 404, { error: "not found" });
    t.done = done;
    await setCollection("todos", todos);
    json(res, 200, { ok: true, todo: t });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
