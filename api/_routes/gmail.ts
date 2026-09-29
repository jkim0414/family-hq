import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { addAudit } from "../_lib/db.js";
import { getGmailConn, disconnectGmail } from "../_lib/gmail.js";
import { inboxConfigured, inboxAddress } from "../_lib/imap.js";
import { watchEnabled, setWatch } from "../_lib/watch.js";

// GET  /api/gmail                 → this parent's connection + watch state, plus the other parent's
// POST /api/gmail { watch: bool } → turn inbox watching on/off for this parent
// POST /api/gmail { disconnect }  → revoke + forget this parent's Google connection
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  const me = user.id as "alex" | "sam";
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      if (typeof body.watch === "boolean") {
        if (body.watch && !inboxConfigured(me)) return json(res, 400, { error: "Connect your Gmail first." });
        await setWatch(me, body.watch);
        await addAudit({ kind: "vault", summary: `${user.name} turned inbox watching ${body.watch ? "on" : "off"}`, by: user.id });
        return json(res, 200, { ok: true, watch: body.watch });
      }
      if (body.disconnect) {
        await disconnectGmail(me);
        await addAudit({ kind: "vault", summary: `${user.name} disconnected their Gmail`, by: user.id });
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: "unknown action" });
    }
    res.setHeader("cache-control", "no-store");
    const other: "alex" | "sam" = me === "alex" ? "sam" : "alex";
    const [mine, theirs, wMe, wOther] = await Promise.all([getGmailConn(me), getGmailConn(other), watchEnabled(me), watchEnabled(other)]);
    const status = (id: "alex" | "sam", conn: typeof mine) =>
      inboxConfigured(id) ? { connected: true, email: inboxAddress(id), via: "app-password" } : { connected: !!conn, email: conn?.email || "", via: conn ? "google" : "" };
    json(res, 200, {
      me: { ...status(me, mine), connectedAt: mine?.connectedAt, watch: wMe },
      other: { id: other, ...status(other, theirs), watch: wOther },
    });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
