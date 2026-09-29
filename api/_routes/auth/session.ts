import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../../_lib/http.js";
import { requireUser, clearSession } from "../../_lib/auth.js";

// GET  /api/auth/session → { user } or 401
// POST /api/auth/session { action: "logout" } → clears the device session
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "POST") {
      await clearSession(req, res);
      return json(res, 200, { ok: true });
    }
    const user = await requireUser(req);
    if (!user) return json(res, 401, { error: "unauthorized" });
    json(res, 200, { user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
