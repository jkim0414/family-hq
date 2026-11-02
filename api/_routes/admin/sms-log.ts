import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authorized, json } from "../../_lib/http.js";
import { KIMI_NUMBER } from "../../_lib/groupsms.js";

// GET /api/admin/sms-log?days=3 (Bearer CRON_SECRET) → recent texts to and from Kimi's number as
// Twilio saw them: status and error code (why one didn't arrive), numbers masked, bodies cut short.
// For diagnosing delivery — Twilio's credentials only live in the deployment.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return json(res, 401, { error: "unauthorized — send the secret as a Bearer header" });
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid) return json(res, 500, { error: "Twilio not configured" });
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const days = Math.min(Math.max(Number(req.query.days) || 3, 1), 14);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const mask = (n?: string) => (n ? `…${n.slice(-4)}` : "");
  const list = async (q: Record<string, string>) => {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?${new URLSearchParams({ ...q, "DateSent>": since, PageSize: "60" })}`, { headers: { authorization: `Basic ${auth}` } });
    if (!r.ok) throw new Error(`Twilio ${r.status}`);
    const data = (await r.json()) as { messages: any[] };
    return data.messages.map((m) => ({ at: m.date_created, dir: m.direction, status: m.status, error: m.error_code, from: mask(m.from), to: mask(m.to), media: Number(m.num_media) || 0, segments: Number(m.num_segments) || 0, price: m.price, body: String(m.body || "").slice(0, 40) }));
  };
  try {
    const [inbound, outbound] = await Promise.all([list({ To: KIMI_NUMBER }), list({ From: KIMI_NUMBER })]);
    return json(res, 200, { since, inbound, outbound });
  } catch (e) {
    return json(res, 502, { error: (e as Error).message });
  }
}
