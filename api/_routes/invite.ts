import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireParent } from "../_lib/auth.js";
import { decideInvitations } from "../_lib/invites.js";
import { canSee } from "../_lib/privacy.js";
import { appendItems } from "../_lib/db.js";
import type { Todo } from "../../src/data/types";

// POST /api/invite { id, going }  — a parent decides on an invitation from the app (Needs you).
// Yes: on the calendar, prep to-dos made, and an "RSVP" to-do when it needs one (by text, Kimi
// offers to RSVP for them instead).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  const user = await requireParent(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const going = body.going === true;
    const r = await decideInvitations([String(body.id || "")], going, user.id, { visible: (e) => canSee(e, user.id) });
    const e = r.events[0];
    if (!e) return json(res, 404, { error: "not found" });
    if (going && (e.invite?.rsvp || e.invite?.rsvpBy)) {
      const t: Todo = { id: `todo-${e.id}-rsvp`, title: `RSVP to ${e.title}`, detail: e.invite.rsvp ? `${e.invite.rsvp} (or ask Kimi to)` : "Or ask Kimi to.", due: e.invite.rsvpBy, priority: "normal", owner: [user.id], people: e.people, done: false, source: e.source, commId: e.commId };
      await appendItems("todos", [t]);
    }
    json(res, 200, { ok: true, status: e.invite?.status, todos: r.todos.length });
  } catch (err) {
    console.error("invite decision failed", err);
    json(res, 500, { error: "Couldn't save that." });
  }
}
