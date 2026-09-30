import type { VercelRequest } from "@vercel/node";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requestOrigin } from "./auth.js";

// Shared Twilio plumbing for the SMS and group-text webhooks.

export const twilioAuth = () => "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");

/** Is this request really from Twilio? (X-Twilio-Signature over the exact URL + sorted form params.) */
export function validTwilioSignature(req: VercelRequest): boolean {
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
export const MEDIA_OK = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/i;
export const MAX_MEDIA_BYTES = 4_500_000;
export type FetchedMedia = { mediaType: string; data: string };

export async function readMedia(res: Response | null, type: string): Promise<FetchedMedia | null> {
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) return null;
  return { mediaType: type === "image/jpg" ? "image/jpeg" : type, data: buf.toString("base64") };
}

// The registered A2P replies — keep identical to the campaign registration and public/sms.html.
export const SMS_WELCOME =
  "Family HQ: Kimi texts household members about family schedules, reminders, alerts and approvals. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Reply Y to confirm.";
export const SMS_HELP =
  "Family HQ: Kimi is our household assistant. For help, email alex@example.com or visit https://your-app.vercel.app/sms.html. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.";

export const OPT_OUT_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT", "CANCEL", "REVOKE", "OPTOUT"];
