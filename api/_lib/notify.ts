import { CONFIG } from "../../src/data/config.js";
import { sendEmail } from "./email.js";
import { userById } from "./auth.js";
import { pushConfigured, sendPush } from "./push.js";
import { redis } from "./db.js";
import type { Channel, Member } from "../../src/data/types";
import { sendGroup } from "./groupsms.js";

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

export function phoneFor(userId: Member): string {
  return userId === "grandma" ? CONFIG.caregivers.grandma.phone : CONFIG.parents[userId].phone;
}

/** Members Kimi may text: the parents, and the caregiver when her texting is on (config sms: true). */
export const textable = (id: Member): boolean => id !== "grandma" || CONFIG.caregivers.grandma.sms;

/** Map an inbound phone number (any formatting) to a member Kimi texts with (null for anyone else). */
export function userForPhone(raw: string): Member | null {
  const digits = raw.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  for (const id of ["alex", "sam", "grandma"] as const) {
    if (textable(id) && phoneFor(id).replace(/\D/g, "").replace(/^1(\d{10})$/, "$1") === digits) return id;
  }
  return null;
}

// ── A2P 10DLC compliance ─────────────────────────────────────────────────────
// Registered program: Kimi texts only household members, after each has
// opted in by texting START and confirming with Y. Twilio's Advanced Opt-Out sends
// the START / STOP / HELP replies; this code tracks the opt-in state and the Y step.

export type SmsOptIn = "pending" | "enrolled" | "stopped";
const optKey = (id: Member) => `sms_optin:${id}`;
export async function getSmsOptIn(id: Member): Promise<SmsOptIn | null> {
  return ((await redis.get<string>(optKey(id))) as SmsOptIn | null) ?? null;
}
export async function setSmsOptIn(id: Member, state: SmsOptIn): Promise<void> {
  await redis.set(optKey(id), state);
}

export const SMS_BRAND = "Kimi (Family HQ)";
/** Kimi's contact card (name, number, and her app avatar) — saving it shows her photo on texts. */
const HQ_URL = process.env.APP_URL || "https://your-app.vercel.app";
export const CONTACT_CARD_URL = `${HQ_URL}/kimi.vcf`;

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
    .replace(/<\/?(strong|b|em|i|u|br|p|span)\b[^>]*>/gi, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2")
    ;
  t = t.replace(/\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|us|io|co|edu|gov|ly|me|app)\/[^\s<>()]*/gi, (url) =>
    url.startsWith(HQ_URL) ? url : "(link in Family HQ)"
  );
  if (!/^(Kimi \()?Family HQ/.test(t)) t = `${SMS_BRAND}: ${t}`;
  return t.trim();
}

/** Send one SMS through Twilio's REST API (no SDK — one form POST). */
export async function sendSms(to: string, rawBody: string, mediaUrl?: string): Promise<void> {
  if (!smsConfigured()) throw new Error("Twilio not configured");
  const body = smsBody(rawBody);
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  // A2P 10DLC: sending via the registered campaign's Messaging Service is the
  // carrier-preferred path; fall back to a bare From number if that's all we have.
  const form = new URLSearchParams({ To: to, Body: body.slice(0, 1500) });
  if (mediaUrl) form.set("MediaUrl", mediaUrl); // sent as MMS (e.g. Kimi's contact card)
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", process.env.TWILIO_FROM!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// iPhones turn a text in exactly this form into a tapback on the quoted message — with curly
// quotes, so smart encoding (which straightens them) must be off. Tested on iOS.
const TAPBACK_VERB: Record<string, string> = { "👍": "Liked", "❤️": "Loved", "😂": "Laughed at", "‼️": "Emphasized", "❓": "Questioned", "👎": "Disliked" };

/** The text a phone sends for a tapback: `Liked “<their message>”` (null for an emoji iPhones can't show). */
export function tapbackText(emoji: string, quoted: string): string | null {
  const verb = TAPBACK_VERB[emoji];
  if (!verb) return null;
  const q = quoted.trim().length > 300 ? quoted.trim().slice(0, 299) + "…" : quoted.trim();
  return `${verb} “${q}”`;
}

/** Kimi reacts to a parent's text the way a phone does: `Liked “<their message>”`. */
export async function sendReactionSms(to: string, emoji: string, quoted: string): Promise<void> {
  const body = tapbackText(emoji, quoted);
  if (!body || !smsConfigured()) return;
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const form = new URLSearchParams({ To: to, Body: body, SmartEncoded: "false" });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", process.env.TWILIO_FROM!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Deliver a proactive assistant message to a member on their channel. */
export async function notify(userId: Member, text: string, channel: Channel, opts: { emailFallback?: boolean; thread?: string } = {}): Promise<void> {
  const u = userById(userId); // null for a caregiver who doesn't sign in to the app (texts only)
  // A chat's group text reaches everyone in it at once; without one, fall back to a one-on-one text.
  if (channel === "group") {
    if (await sendGroup(opts.thread || "task-main", text).catch((e) => (console.error("group send failed", e), false))) return;
    channel = "sms";
  }
  // Text only a member who has completed opt-in (START, then Y); otherwise push/email.
  if (channel === "sms" && smsConfigured() && textable(userId) && (await getSmsOptIn(userId)) === "enrolled") {
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
  if (opts.emailFallback === false || !u) return; // timely nudges (leave-by) are pointless as email
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  await sendEmail(`Kimi: ${text.split("\n")[0].slice(0, 70)}`, `<div style="font-family:system-ui,sans-serif;max-width:560px"><p>${esc}</p><p style="margin-top:16px"><a href="https://your-app.vercel.app/chat">Reply in the hub →</a></p></div>`, {
    to: [u.email],
    text,
  });
}

/** Deliver one message to several parents: once to the group text when that's the channel, else to each. */
export async function deliver(to: Member[], text: string, channel: Channel, thread = "task-main"): Promise<void> {
  if (channel === "group" && (await sendGroup(thread, text).catch(() => false))) return;
  for (const p of to) await notify(p, text, channel === "group" ? "sms" : channel).catch((e) => console.error("notify failed", e));
}
