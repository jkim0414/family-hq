import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { converse, appendExchange } from "../_lib/agent.js";
import { runCapture, describeCapture } from "../_lib/capture.js";
import { chatFor, threadMembers } from "../_lib/privacy.js";
import { pushConfigured, sendPush } from "../_lib/push.js";

// POST /api/chat { message, attachments? }  — the one place to tell Kimi anything.
//
// Two engines behind one composer, chosen here so the parent never has to:
// - Anything with a photo / PDF goes through the fast "file this" pipeline
//   (classify → events/to-dos/reconcile) and the thread gets a "Filed: …" reply
//   in a few seconds.
// - Plain text goes to the assistant, which can answer, file, edit, research,
//   draft email, or hand off a browser task.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const message = String(body?.message || "").trim();
    const attachments: { mediaType?: string; data: string }[] = Array.isArray(body?.attachments) ? body.attachments.filter((a: any) => a?.data) : [];
    if (!message && !attachments.length) return json(res, 400, { error: "message required" });
    // Which chat: "private" (Just me), the family chat, or a shared chat this member is in.
    const threadId = chatFor(body?.thread, user.id);
    if (!threadId) return json(res, 403, { error: "not your chat" });

    // In a shared chat with Grandma, the others get a nudge that someone wrote (they read it in the app).
    const others = threadId === "task-main" ? [] : threadMembers(threadId).filter((m) => m !== user.id);
    if (others.length && pushConfigured()) {
      const body = message || "sent a photo";
      await Promise.all(others.map((m) => sendPush(m, { title: `${user.name} · Kimi chat`, body: body.length > 140 ? body.slice(0, 137) + "…" : body, url: "/chat", tag: threadId }).catch(() => 0)));
    }

    if (attachments.length) {
      const result = await runCapture({ text: message, images: attachments });
      const kinds = attachments.map((a) => ((a.mediaType || "").includes("pdf") ? "PDF" : "photo"));
      const shown = `${message || "(no note)"}\n📎 ${kinds.length} ${kinds.length === 1 ? kinds[0] : "attachments"}`;
      const task = await appendExchange(threadId, user.id, "app", shown, describeCapture(result));
      return json(res, 200, { ok: true, reply: task.lastReply, pending: false, status: task.status, log: task.log.slice(-60), filed: result });
    }

    const { reply, task } = await converse(threadId, user.id, "app", message, Date.now() + 100_000);
    json(res, 200, { ok: true, reply: reply || null, pending: !reply, status: task.status, log: task.log.slice(-60) });
  } catch (err) {
    if (String(err).includes("busy")) return json(res, 409, { error: "The assistant is mid-task — try again in a moment." });
    json(res, 500, { error: String(err) });
  }
}
