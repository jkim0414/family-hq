import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { getTaskMeta, getTaskMetas, listTaskIds } from "../_lib/db.js";
import { stopTask } from "../_lib/agent.js";
import { canSee, privateThreadId } from "../_lib/privacy.js";
import { waitUntil } from "@vercel/functions";
import { redis } from "../_lib/db.js";
import { withReactions, REACTIONS, REACTIONS_VER } from "../_lib/reactions.js";
import { handleReaction } from "../_lib/tapbacks.js";

// GET  /api/tasks           → light list of tasks
// POST /api/tasks {id, stop} → stop a background task now
// POST /api/tasks {thread: "family"|"private", react: {at, kind, emoji}} → toggle your reaction on a message
// GET /api/tasks?id=…      → one task's transcript (no raw model thread)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      if (body.stop && body.id) {
        if (!canSee(await getTaskMeta(String(body.id)), user.id)) return json(res, 404, { error: "not a browser task" });
        const t = await stopTask(String(body.id), user.id);
        return t ? json(res, 200, { ok: true, status: t.status }) : json(res, 404, { error: "not a browser task" });
      }
      if (body.react) {
        const threadId = body.thread === "private" ? privateThreadId(user.id) : "task-main";
        const meta = await getTaskMeta(threadId);
        if (!meta || !canSee(meta, user.id)) return json(res, 404, { error: "no such thread" });
        const { at, kind, emoji } = body.react || {};
        const entry = meta.log.find((e) => e.at === at && e.kind === kind && (kind === "user" || kind === "assistant"));
        if (!entry || !REACTIONS.includes(String(emoji))) return json(res, 400, { error: "bad reaction" });
        // A 👍 on Kimi's latest offer is a yes: she carries on in the background (the chat polls for it).
        let resolve: (r: string) => void = () => {};
        const done = new Promise<string>((r) => (resolve = r));
        waitUntil(
          handleReaction(threadId, user.id, "app", entry, String(emoji), Date.now() + 240_000)
            .then((r) => resolve(r.reply ? "replying" : "ok"))
            .catch((e) => (console.error("app reaction failed", e), resolve("error")))
        );
        // Answer as soon as the reaction is stored (Kimi's reply, if any, arrives by polling).
        const state = await Promise.race([done, new Promise<string>((r) => setTimeout(() => r("replying"), 1500))]);
        return json(res, 200, { ok: true, state });
      }
      return json(res, 400, { error: "unknown action" });
    }
    res.setHeader("cache-control", "no-store");
    // "private" = the signed-in parent's own "Just me" thread with Kimi.
    const rawId = typeof req.query.id === "string" ? req.query.id : "";
    const id = rawId === "private" ? privateThreadId(user.id) : rawId;
    if (id) {
      const t = await getTaskMeta(id);
      if (!t || !canSee(t, user.id)) return json(res, 200, { task: null });
      // ?after=<iso> → just the count of assistant replies since then (the unread badge).
      if (typeof req.query.after === "string") {
        const after = req.query.after;
        return json(res, 200, { unread: t.log.filter((e) => e.kind === "assistant" && e.at > after).length, updatedAt: t.updatedAt });
      }
      return json(res, 200, { task: { ...t, log: await withReactions(id, t.log) }, me: user.id });
    }
    const metas = (await getTaskMetas(await listTaskIds())).filter((t) => canSee(t, user.id));
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
      privateTo: t.privateTo,
    }));
    json(res, 200, { tasks, reactionsVer: Number((await redis.get(REACTIONS_VER).catch(() => 0)) || 0) });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
