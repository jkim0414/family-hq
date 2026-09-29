import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getCollection, setCollection, redis } from "../_lib/db.js";
import { applyOp } from "../_lib/metadata.js";
import { deleteCalendarEvent, patchCalendarEvent } from "../_lib/calendar.js";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";

// POST /api/suggestion  { id, action: "apply" | "dismiss" }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!(await requireUser(req))) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { id, action } = body || {};
    const suggestions = await getCollection("suggestions");
    const s = suggestions.find((x) => x.id === id);
    if (!s) return json(res, 404, { error: "not found" });

    if (action === "apply") {
      if (s.op.kind === "delete_events") {
        // Calendar command: delete each matched event (best-effort).
        for (const id of s.op.eventIds) await deleteCalendarEvent(id).catch(() => {});
        // Reconcile flow: also remove the matching app-store events.
        const gone = new Set([...(s.op.storeIds || []), ...s.op.eventIds]);
        if (gone.size) {
          const events = await getCollection("events");
          const keep = events.filter((e) => !gone.has(e.id) && !(e.gcalId && gone.has(e.gcalId)));
          if (keep.length !== events.length) await setCollection("events", keep);
        }
      } else if (s.op.kind === "edit_events") {
        for (const id of s.op.eventIds) await patchCalendarEvent(id, s.op.set).catch(() => {});
      } else {
        const [kids, contacts, routines] = await Promise.all([
          getCollection("kids"),
          getCollection("contacts"),
          getCollection("routines"),
        ]);
        const ctx = { kids, contacts, routines };
        const changed = applyOp(s.op, ctx);
        if (changed.includes("kids")) await setCollection("kids", kids);
        if (changed.includes("contacts")) await setCollection("contacts", contacts);
        if (changed.includes("routines")) await setCollection("routines", routines);
      }
    } else if (action !== "dismiss") {
      return json(res, 400, { error: "action must be apply or dismiss" });
    }

    // Record the id permanently so recurring generators (e.g. the seasonal
    // promotion check, which runs on every digest) never re-propose something
    // the user already applied or dismissed.
    await redis.sadd("handled_suggestions", id).catch(() => {});
    await setCollection("suggestions", suggestions.filter((x) => x.id !== id));
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
