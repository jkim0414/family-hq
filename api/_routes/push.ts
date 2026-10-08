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
      // Only a real push service: the server posts to this address.
      let host = "";
      try { host = new URL(String(sub.endpoint)).protocol === "https:" ? new URL(String(sub.endpoint)).hostname : ""; } catch { /* invalid */ }
      if (!/(^|\.)(push\.apple\.com|fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(host)) return json(res, 400, { error: "not a push service endpoint" });
      return json(res, 200, { ok: true, devices: await addSubscription(user.id, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }) });
    }
    json(res, 200, { configured: pushConfigured(), publicKey: publicKey(), devices: (await getSubscriptions(user.id)).length });
  } catch (err) {
    console.error("push route failed", err);
    json(res, 500, { error: "Couldn't update notifications." });
  }
}
