import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { requestOrigin } from "../_lib/auth.js";
import { userForPhone, sendSms, smsBody, smsConfigured, getSmsOptIn, setSmsOptIn } from "../_lib/notify.js";
import { converse, appendExchange, MAIN_TASK_ID } from "../_lib/agent.js";
import { runCapture, describeCapture } from "../_lib/capture.js";
import { latestPending, decideAction } from "../_lib/actions.js";

// POST /api/sms — Twilio inbound-message webhook. Both parents text one number;
// messages land on the shared family thread and the reply is texted back.
// Twilio expects a response within ~15s, so we acknowledge immediately and let
// the agent run in the background (waitUntil); the cron resumes it if needed.

function validSignature(req: VercelRequest): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sig = req.headers["x-twilio-signature"];
  if (!token || typeof sig !== "string") return false;
  // Under the catch-all router, rebuild the exact URL Twilio signed:
  // origin + /api/<route segments> + original query (minus the router's own `path`).
  const segs = req.query.path;
  const routePath = (Array.isArray(segs) ? segs : [segs]).filter(Boolean).join("/") || "sms";
  const qs = new URLSearchParams((req.url || "").split("?")[1] || "");
  qs.delete("path");
  const q = qs.toString();
  const url = `${requestOrigin(req)}/api/${routePath}${q ? "?" + q : ""}`;
  const params = (req.body || {}) as Record<string, string>;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Photos and PDFs texted to Kimi (a flyer, a screenshot of a class-parent group chat)
// are filed like attachments in the app. Claude reads JPEG/PNG/GIF/WebP images and PDFs.
const MEDIA_OK = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/i;
const MAX_MEDIA_BYTES = 4_500_000;

async function fetchTwilioMedia(body: Record<string, string>): Promise<{ mediaType: string; data: string }[]> {
  const n = Math.min(Number(body.NumMedia || 0), 4);
  const auth = "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const out: { mediaType: string; data: string }[] = [];
  for (let i = 0; i < n; i++) {
    const url = body[`MediaUrl${i}`];
    const type = (body[`MediaContentType${i}`] || "").toLowerCase();
    if (!url || !MEDIA_OK.test(type)) continue;
    const r = await fetch(url, { headers: { authorization: auth } }).catch(() => null);
    if (!r?.ok) continue;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) continue;
    out.push({ mediaType: type === "image/jpg" ? "image/jpeg" : type, data: buf.toString("base64") });
  }
  return out;
}

const twiml = (res: VercelResponse, body = "") => {
  res.setHeader("content-type", "text/xml");
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("POST only");
  if (!smsConfigured()) return res.status(503).send("SMS not configured");
  if (!validSignature(req)) return res.status(403).send("bad signature");

  const body = (req.body || {}) as Record<string, string>;
  const from = body.From || "";
  const text = (body.Body || "").trim();
  const who = userForPhone(from);
  if (!who || !text) return twiml(res); // unknown sender or empty → silently ignore

  // Opt-in / opt-out keywords. Twilio's Advanced Opt-Out sends the registered replies
  // to START / STOP / HELP; we only record the state (and never add a second reply).
  const word = text.toUpperCase().replace(/[^A-Z]/g, "");
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT", "CANCEL", "REVOKE", "OPTOUT"].includes(word)) {
    await setSmsOptIn(who, "stopped");
    return twiml(res);
  }
  if (word === "START" || word === "UNSTOP") {
    await setSmsOptIn(who, "pending");
    return twiml(res);
  }
  // YES is one of Twilio's reserved opt-in keywords: Twilio answers a bare "yes" with the
  // welcome message itself. It never completes enrollment (only "Y" does — see below) and
  // it isn't an approval shortcut, so we add nothing; an enrolled parent's "yes" still
  // reaches Kimi as an ordinary reply.
  const state = await getSmsOptIn(who);
  if (word === "YES" && state !== "enrolled") return twiml(res);
  if (word === "HELP" || word === "INFO") return twiml(res);

  // Double opt-in: after START's welcome, "Y" completes enrollment.
  if (state === "pending") {
    if (word === "Y") {
      await setSmsOptIn(who, "enrolled");
      return twiml(
        res,
        "<Message>Family HQ: You're enrolled. Kimi will text you about your household. Msg frequency varies. Msg &amp; data rates may apply. Reply HELP for help, STOP to opt out.</Message>"
      );
    }
    return twiml(res); // not confirmed yet — send nothing else
  }
  if (state !== "enrolled") return twiml(res); // never opted in, or opted out

  // A photo or PDF: file it (like an attachment in the app) and text back what was filed.
  if (Number(body.NumMedia || 0) > 0) {
    waitUntil(
      (async () => {
        try {
          const media = await fetchTwilioMedia(body);
          if (!media.length) {
            await sendSms(from, "I couldn't open that attachment. Send a photo (JPEG or PNG) or a PDF, or add it in Family HQ.");
            return;
          }
          const result = await runCapture({ text, images: media });
          const reply = describeCapture(result);
          const shown = `${text || "(no note)"}\n📎 ${media.length} ${media.length === 1 ? "attachment" : "attachments"} by text`;
          await appendExchange(MAIN_TASK_ID, who, "sms", shown, reply).catch((e) => console.error("sms media: thread append failed", e));
          await sendSms(from, reply);
        } catch (e) {
          console.error("sms media failed", e);
          await sendSms(from, "Something went wrong filing that. Try again, or add it in Family HQ.").catch(() => {});
        }
      })()
    );
    return twiml(res);
  }

  // Approval shortcut: "APPROVE" / "DECLINE" acts on the most recent pending
  // proposal without waking the agent. Fast enough to answer inline. ("Cancel" is
  // not a shortcut: carriers treat CANCEL as an opt-out keyword, and "yes" isn't
  // either: Twilio reserves YES as an opt-in keyword.)
  const cmd = text.toLowerCase();
  if (/^(approve|send|ok|decline|no)\b/.test(cmd)) {
    const pending = await latestPending();
    if (!pending) return twiml(res, `<Message>${smsBody("Nothing is waiting for approval right now.")}</Message>`);
    const approve = /^(approve|send|ok)/.test(cmd);
    const a = await decideAction(pending.id, approve ? "approve" : "decline", who);
    const msg = a.status === "executed" ? `✅ ${a.title} — ${a.result}` : a.status === "declined" ? `Declined: ${a.title}` : `⚠️ ${a.title} failed: ${a.error}`;
    return twiml(res, `<Message>${smsBody(msg).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Message>`);
  }

  waitUntil(
    (async () => {
      try {
        const { reply } = await converse(MAIN_TASK_ID, who, "sms", text, Date.now() + 200_000);
        if (reply) await sendSms(from, reply);
      } catch (e) {
        console.error("sms converse failed", e);
        if (String(e).includes("busy")) await sendSms(from, "One sec — I'm mid-task. Text me again in a minute.").catch(() => {});
      }
    })()
  );
  twiml(res);
}
