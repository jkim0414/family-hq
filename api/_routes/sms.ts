import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { validTwilioSignature, twilioAuth, readMedia, MEDIA_OK, SMS_WELCOME, SMS_HELP, OPT_OUT_WORDS, type FetchedMedia } from "../_lib/twilio.js";
import { ensureGroup, closeGroupAfterStop, getGroup, postedToGroup } from "../_lib/groupsms.js";
import { userForPhone, sendSms, smsBody, smsConfigured, getSmsOptIn, setSmsOptIn, CONTACT_CARD_URL } from "../_lib/notify.js";
import { converse, appendExchange } from "../_lib/agent.js";
import { privateThreadId } from "../_lib/privacy.js";
import { runCapture, describeCapture } from "../_lib/capture.js";
import { latestPending, decideAction } from "../_lib/actions.js";

// POST /api/sms — Twilio inbound-message webhook for one-on-one texts. Each parent's texts
// land on their private "Just me" thread and the reply is texted back. (The family group
// text arrives through Twilio Conversations instead — see smsgroup.ts.)
// Twilio expects a response within ~15s, so we acknowledge immediately and let
// the agent run in the background (waitUntil); the cron resumes it if needed.

async function fetchTwilioMedia(body: Record<string, string>): Promise<FetchedMedia[]> {
  const n = Math.min(Number(body.NumMedia || 0), 4);
  const out: FetchedMedia[] = [];
  for (let i = 0; i < n; i++) {
    const url = body[`MediaUrl${i}`];
    const type = (body[`MediaContentType${i}`] || "").toLowerCase();
    if (!url || !MEDIA_OK.test(type)) continue;
    const m = await readMedia(await fetch(url, { headers: { authorization: twilioAuth() } }).catch(() => null), type);
    if (m) out.push(m);
  }
  return out;
}

const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const twiml = (res: VercelResponse, body = "") => {
  res.setHeader("content-type", "text/xml");
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("POST only");
  if (!smsConfigured()) return res.status(503).send("SMS not configured");
  if (!validTwilioSignature(req)) return res.status(403).send("bad signature");

  const body = (req.body || {}) as Record<string, string>;
  const from = body.From || "";
  const text = (body.Body || "").trim();
  const who = userForPhone(from);
  if (!who || (!text && !Number(body.NumMedia || 0))) return twiml(res); // unknown sender or empty → silently ignore

  // Opt-in / opt-out keywords. Twilio blocks and confirms STOP itself; the registered welcome
  // (START) and help (HELP) replies are sent from here, word for word as registered — Twilio's
  // own START reply only goes to numbers re-subscribing after a STOP. (If Advanced Opt-Out in the
  // Twilio console also has an opt-in or help message set, clear it there to avoid a duplicate.)
  const word = text.toUpperCase().replace(/[^A-Z]/g, "");

  // A family group text also arrives here; the group handler (smsgroup.ts) answers it there.
  if (!["START", "UNSTOP", "Y"].includes(word) && (await getGroup()) && (await postedToGroup(from, text))) return twiml(res);
  if (OPT_OUT_WORDS.includes(word)) {
    await setSmsOptIn(who, "stopped");
    waitUntil(closeGroupAfterStop(who));
    return twiml(res);
  }
  if (word === "START" || word === "UNSTOP") {
    await setSmsOptIn(who, "pending");
    return twiml(res, `<Message>${xml(SMS_WELCOME)}</Message>`);
  }
  // YES is one of Twilio's reserved opt-in keywords: Twilio answers a bare "yes" with the
  // welcome message itself. It never completes enrollment (only "Y" does — see below) and
  // it isn't an approval shortcut, so we add nothing; an enrolled parent's "yes" still
  // reaches Kimi as an ordinary reply.
  const state = await getSmsOptIn(who);
  if (word === "YES" && state !== "enrolled") return twiml(res);
  if (word === "HELP" || word === "INFO") return twiml(res, `<Message>${xml(SMS_HELP)}</Message>`);

  // Double opt-in: after START's welcome, "Y" completes enrollment.
  if (state === "pending") {
    if (word === "Y") {
      await setSmsOptIn(who, "enrolled");
      // Right after the confirmation: Kimi's contact card, so her photo shows next to her texts.
      waitUntil(
        (async () => {
          await new Promise((r) => setTimeout(r, 3000));
          await sendSms(from, "Here's my contact card. Tap it and save me so my photo shows up next to my texts! ✨", CONTACT_CARD_URL).catch((e) => console.error("contact card failed", e));
          // Once both parents are enrolled, start the family group text (no-op until then).
          await new Promise((r) => setTimeout(r, 3000));
          await ensureGroup().catch((e) => console.error("group text setup failed", e));
        })()
      );
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
          await appendExchange(privateThreadId(who), who, "sms", shown, reply).catch((e) => console.error("sms media: thread append failed", e));
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
    const pending = await latestPending(who);
    if (!pending) return twiml(res, `<Message>${smsBody("Nothing is waiting for approval right now.")}</Message>`);
    const approve = /^(approve|send|ok)/.test(cmd);
    const a = await decideAction(pending.id, approve ? "approve" : "decline", who);
    const msg = a.status === "executed" ? `✅ ${a.title} — ${a.result}` : a.status === "declined" ? `Declined: ${a.title}` : `⚠️ ${a.title} failed: ${a.error}`;
    return twiml(res, `<Message>${smsBody(msg).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Message>`);
  }

  waitUntil(
    (async () => {
      try {
        // One-on-one texts are this parent's private "Just me" thread (a group text would be the family chat).
        const { reply } = await converse(privateThreadId(who), who, "sms", text, Date.now() + 200_000);
        if (reply) await sendSms(from, reply);
      } catch (e) {
        console.error("sms converse failed", e);
        if (String(e).includes("busy")) await sendSms(from, "One sec — I'm mid-task. Text me again in a minute.").catch(() => {});
      }
    })()
  );
  twiml(res);
}
