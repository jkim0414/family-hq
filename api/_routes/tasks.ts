import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { getTaskMeta, getTaskMetas, listTaskIds } from "../_lib/db.js";
import { stopTask } from "../_lib/agent.js";

// GET  /api/tasks           → light list of tasks
// POST /api/tasks {id, stop} → stop a background task now
// GET /api/tasks?id=…      → one task's transcript (no raw model thread)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      if (body.stop && body.id) {
        const t = await stopTask(String(body.id), user.id);
        return t ? json(res, 200, { ok: true, status: t.status }) : json(res, 404, { error: "not a browser task" });
      }
      return json(res, 400, { error: "unknown action" });
    }
    res.setHeader("cache-control", "no-store");
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (id) {
      const t = await getTaskMeta(id);
      if (!t) return json(res, 200, { task: null });
      // ?after=<iso> → just the count of assistant replies since then (the unread badge).
      if (typeof req.query.after === "string") {
        const after = req.query.after;
        return json(res, 200, { unread: t.log.filter((e) => e.kind === "assistant" && e.at > after).length, updatedAt: t.updatedAt });
      }
      return json(res, 200, { task: t });
    }
    const metas = await getTaskMetas(await listTaskIds());
    const tasks = metas.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      kind: t.kind || "chat",
      channel: t.channel,
      updatedAt: t.updatedAt,
      nextCheckAt: t.nextCheckAt,
      followupNote: t.followupNote,
      lastReply: t.lastReply,
    }));
    json(res, 200, { tasks });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
