import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { pushConfigured, publicKey, addSubscription, removeSubscription, getSubscriptions } from "../_lib/push.js";

// GET  /api/push                          → { configured, publicKey, devices }
// POST /api/push { subscription }         → enable on this device
// POST /api/push { unsubscribe: endpoint } → disable on this device
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    res.setHeader("cache-control", "no-store");
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      if (body.unsubscribe) return json(res, 200, { ok: true, devices: await removeSubscription(user.id, String(body.unsubscribe)) });
      const sub = body.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: "subscription required" });
      return json(res, 200, { ok: true, devices: await addSubscription(user.id, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }) });
    }
    json(res, 200, { configured: pushConfigured(), publicKey: publicKey(), devices: (await getSubscriptions(user.id)).length });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
