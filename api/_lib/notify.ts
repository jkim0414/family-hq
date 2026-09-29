import { CONFIG } from "../../src/data/config.js";
import { sendEmail } from "./email.js";
import { userById } from "./auth.js";
import { pushConfigured, sendPush } from "./push.js";
import { redis } from "./db.js";
import type { Channel } from "../../src/data/types";

// Outbound delivery for the assistant's proactive messages: SMS via Twilio when
// the conversation is on SMS; otherwise a push notification to the parent's
// installed app, falling back to email when no device is subscribed.

export function smsConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM)
  );
}

export function phoneFor(userId: "alex" | "sam"): string {
  return userId === "alex" ? CONFIG.parents.alex.phone : CONFIG.parents.sam.phone;
}

/** Map an inbound phone number (any formatting) to a parent. */
export function userForPhone(raw: string): "alex" | "sam" | null {
  const digits = raw.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  for (const id of ["alex", "sam"] as const) {
    if (phoneFor(id).replace(/\D/g, "").replace(/^1(\d{10})$/, "$1") === digits) return id;
  }
  return null;
}

// ── A2P 10DLC compliance ─────────────────────────────────────────────────────
// Registered program: Kimi texts only the two household members, after each has
// opted in by texting START and confirming with Y. Twilio's Advanced Opt-Out sends
// the START / STOP / HELP replies; this code tracks the opt-in state and the Y step.

export type SmsOptIn = "pending" | "enrolled" | "stopped";
const optKey = (id: "alex" | "sam") => `sms_optin:${id}`;
export async function getSmsOptIn(id: "alex" | "sam"): Promise<SmsOptIn | null> {
  return ((await redis.get<string>(optKey(id))) as SmsOptIn | null) ?? null;
}
export async function setSmsOptIn(id: "alex" | "sam", state: SmsOptIn): Promise<void> {
  await redis.set(optKey(id), state);
}

export const SMS_BRAND = "Kimi (Family HQ)";
const HQ_URL = process.env.APP_URL || "https://your-app.vercel.app";

/**
 * Every outgoing text: brand prefix (so the sender is clear, as registered), plain text
 * instead of Markdown, and only Family HQ links — the registration declares no
 * third-party links, so an outside URL is replaced with a pointer to the app.
 */
export function smsBody(raw: string): string {
  let t = raw
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2")
    ;
  t = t.replace(/\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|us|io|co|edu|gov|ly|me|app)\/[^\s<>()]*/gi, (url) =>
    url.startsWith(HQ_URL) ? url : "(link in Family HQ)"
  );
  if (!/^(Kimi \()?Family HQ/.test(t)) t = `${SMS_BRAND}: ${t}`;
  return t.trim();
}

/** Send one SMS through Twilio's REST API (no SDK — one form POST). */
export async function sendSms(to: string, rawBody: string): Promise<void> {
  if (!smsConfigured()) throw new Error("Twilio not configured");
  const body = smsBody(rawBody);
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  // A2P 10DLC: sending via the registered campaign's Messaging Service is the
  // carrier-preferred path; fall back to a bare From number if that's all we have.
  const form = new URLSearchParams({ To: to, Body: body.slice(0, 1500) });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", process.env.TWILIO_FROM!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Deliver a proactive assistant message to a parent on their channel. */
export async function notify(userId: "alex" | "sam", text: string, channel: Channel, opts: { emailFallback?: boolean } = {}): Promise<void> {
  const u = userById(userId);
  if (!u) return;
  // Text only a parent who has completed opt-in (START, then Y); otherwise push/email.
  if (channel === "sms" && smsConfigured() && (await getSmsOptIn(userId)) === "enrolled") {
    await sendSms(phoneFor(userId), text);
    return;
  }
  if (pushConfigured()) {
    const first = text.split("\n")[0].trim();
    const sent = await sendPush(userId, {
      title: "Kimi",
      body: text.length > 180 ? text.slice(0, 177) + "…" : text,
      url: "/chat",
      tag: first.slice(0, 40),
    }).catch(() => 0);
    if (sent > 0) return;
  }
  if (opts.emailFallback === false) return; // timely nudges (leave-by) are pointless as email
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  await sendEmail(`Kimi: ${text.split("\n")[0].slice(0, 70)}`, `<div style="font-family:system-ui,sans-serif;max-width:560px"><p>${esc}</p><p style="margin-top:16px"><a href="https://your-app.vercel.app/chat">Reply in the hub →</a></p></div>`, {
    to: [u.email],
    text,
  });
}
