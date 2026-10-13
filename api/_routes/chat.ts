import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { waitUntil } from "@vercel/functions";
import { converse, mirrorAppTurn } from "../_lib/agent.js";
import { chatFor } from "../_lib/privacy.js";

// POST /api/chat { message, attachments? }  — the one place to tell Kimi anything.
//
// Everything goes to Kimi, photos and PDFs included: she reads them with the words and decides —
// file them (file_attachments, the same pipeline as forwarded email) or use them for what was asked.
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

    const { reply, task } = await converse(threadId, user.id, "app", message, Date.now() + 100_000, { attachments });
    // The conversation reaches people by text too (the group text for a shared chat; you, for Just
    // me), so the text thread has it all. A reply still in progress follows by text when it's done.
    const said = message || (attachments.length > 1 ? `(${attachments.length} attachments)` : "(a photo)");
    waitUntil(mirrorAppTurn(threadId, user.id, said, reply || null).catch((e) => console.error("mirror to text failed", e)));
    json(res, 200, { ok: true, reply: reply || null, pending: !reply, status: task.status, log: task.log.slice(-60) });
  } catch (err) {
    if (String(err).includes("busy")) return json(res, 409, { error: "The assistant is mid-task — try again in a moment." });
    json(res, 500, { error: String(err) });
  }
}
