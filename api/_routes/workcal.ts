import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { addAudit } from "../_lib/db.js";
import { getWorkCalConfig, setWorkCalConfig, parseWorkCalInput, getWorkBlocks, type Parent } from "../_lib/workcal.js";

// GET  /api/workcal                         → both parents' work-calendar status (+ a quick read test)
// POST /api/workcal { who, value }          → set a parent's work calendar (email if shared, or .ics link)
// POST /api/workcal { who, remove: true }   → disconnect
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  res.setHeader("cache-control", "no-store");
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const who: Parent = body.who === "sam" ? "sam" : "alex";
      if (body.remove) {
        await setWorkCalConfig(who, null);
        await addAudit({ kind: "vault", summary: `Disconnected ${who === "alex" ? "Alex" : "Sam"}'s work calendar`, by: user.id });
        return json(res, 200, { ok: true });
      }
      const cfg = parseWorkCalInput(String(body.value || ""));
      if (!cfg) return json(res, 400, { error: "Enter the work email address (if you shared the calendar with alex@example.com) or a calendar link." });
      await setWorkCalConfig(who, cfg);
      // Prove it works before saying so.
      const now = new Date();
      try {
        const blocks = await getWorkBlocks(who, now, new Date(+now + 7 * 86400000));
        await addAudit({ kind: "vault", summary: `Connected ${who === "alex" ? "Alex" : "Sam"}'s work calendar (${cfg.source === "google" ? cfg.id : "calendar link"})`, by: user.id });
        return json(res, 200, { ok: true, source: cfg.source, next7days: blocks.length, busyOnly: blocks.length > 0 && blocks.every((b) => b.title === "Busy") });
      } catch (e) {
        await setWorkCalConfig(who, null);
        return json(res, 400, { error: `Couldn't read that calendar: ${String((e as Error).message || e).slice(0, 200)}` });
      }
    }
    const status = async (p: Parent) => {
      const cfg = await getWorkCalConfig(p);
      if (!cfg) return { connected: false };
      const now = new Date();
      try {
        const blocks = await getWorkBlocks(p, now, new Date(+now + 7 * 86400000));
        return { connected: true, source: cfg.source, label: cfg.source === "google" ? cfg.id : "calendar link", next7days: blocks.length, busyOnly: blocks.length > 0 && blocks.every((b) => b.title === "Busy") };
      } catch (e) {
        return { connected: true, source: cfg.source, label: cfg.source === "google" ? cfg.id : "calendar link", error: String((e as Error).message || e).slice(0, 160) };
      }
    };
    const [alex, sam] = await Promise.all([status("alex"), status("sam")]);
    json(res, 200, { alex, sam, shareWith: "alex@example.com" });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
