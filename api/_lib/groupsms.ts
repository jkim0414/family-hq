import { redis } from "./db.js";
import { twilioAuth, readMedia, MEDIA_OK, type FetchedMedia } from "./twilio.js";
import { smsBody, sendSms, getSmsOptIn, phoneFor, smsConfigured } from "./notify.js";
import { CONFIG } from "../../src/data/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// The family group text: Alex, Sam, and Kimi in one thread on their phones.
// A phone number can't join a group text by itself, so this is a Twilio
// Conversations "Group MMS" conversation: each parent is an SMS participant and
// Kimi is a participant projected onto her number, so her messages come from it.
// Group messages reach /api/sms/group (a conversation webhook) and go to the
// family chat; one-on-one texts still reach /api/sms (Twilio only routes a
// message to the group when the whole set of people matches). US numbers only,
// green-bubble MMS, max 10 people. It's created once both parents have opted in.
// ─────────────────────────────────────────────────────────────────────────────

const API = "https://conversations.twilio.com/v1";
const KEY = "sms_group";
export const KIMI_IDENTITY = "kimi";
export const KIMI_NUMBER = process.env.TWILIO_FROM || "+15550100100";
const WEBHOOK_URL = `${process.env.APP_URL || "https://your-app.vercel.app"}/api/sms/group`;

const firstName = (p: "alex" | "sam") => CONFIG.parents[p].name.split(" ")[0];

export interface Group {
  sid: string;
  createdAt: string;
  /** Kimi's last message in the group, so a quick "yes please" reads as an answer to her. */
  lastKimiAt?: string;
  lastKimiText?: string;
}

async function tw<T = Record<string, unknown>>(path: string, form?: Record<string, string>, method = form ? "POST" : "GET"): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: twilioAuth(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (!res.ok) throw new Error(`Twilio Conversations ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? {} : await res.json()) as T;
}

export async function getGroup(): Promise<Group | null> {
  return (await redis.get<Group>(KEY).catch(() => null)) ?? null;
}

/**
 * Create the group text if both parents have opted in and there isn't one yet, and say hello.
 * Safe to call any time; returns the group (or null when not everyone is enrolled).
 */
export async function ensureGroup(): Promise<Group | null> {
  const existing = await getGroup();
  if (existing) return existing;
  if (!smsConfigured()) return null;
  const [a, b] = await Promise.all([getSmsOptIn("alex"), getSmsOptIn("sam")]);
  if (a !== "enrolled" || b !== "enrolled") return null;
  if (!(await redis.set(`${KEY}_lock`, "1", { nx: true, ex: 60 }))) return null;
  let sid = "";
  try {
    const conv = await tw<{ sid: string }>("/Conversations", {
      FriendlyName: "Family HQ",
      // Send through the registered A2P campaign's Messaging Service.
      ...(process.env.TWILIO_MESSAGING_SERVICE_SID ? { MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID } : {}),
    });
    sid = conv.sid;
    await tw(`/Conversations/${sid}/Participants`, { Identity: KIMI_IDENTITY, "MessagingBinding.ProjectedAddress": KIMI_NUMBER });
    for (const p of ["alex", "sam"] as const) await tw(`/Conversations/${sid}/Participants`, { "MessagingBinding.Address": phoneFor(p) });
    await tw(`/Conversations/${sid}/Webhooks`, {
      Target: "webhook",
      "Configuration.Url": WEBHOOK_URL,
      "Configuration.Method": "POST",
      "Configuration.Filters": "onMessageAdded",
    });
    const group: Group = { sid, createdAt: new Date().toISOString() };
    await redis.set(KEY, group);
    await sendGroup(
      `Hi ${firstName("alex")} and ${firstName("sam")}! 👋 This is our family group text. Talk to each other here like normal. When you want me, just say "Kimi" ("Kimi, add swim Tuesday at 4") and I'll answer here for both of you. Everything here also shows up in the Family chat in the app.`
    );
    return group;
  } catch (e) {
    if (sid) await tw(`/Conversations/${sid}`, undefined, "DELETE").catch(() => {});
    throw e;
  } finally {
    await redis.del(`${KEY}_lock`).catch(() => {});
  }
}

/** Kimi says something in the group text (branded, plain text, HQ links only — like every text). */
export async function sendGroup(raw: string): Promise<boolean> {
  const g = await getGroup();
  if (!g) return false;
  const body = smsBody(raw).slice(0, 1500);
  await tw(`/Conversations/${g.sid}/Messages`, { Author: KIMI_IDENTITY, Body: body });
  await redis.set(KEY, { ...g, lastKimiAt: new Date().toISOString(), lastKimiText: body.slice(0, 500) });
  return true;
}

/** Tear the group down (someone opted out — Kimi can't text them anymore). */
export async function closeGroup(): Promise<void> {
  const g = await getGroup();
  if (!g) return;
  await redis.del(KEY);
  await tw(`/Conversations/${g.sid}`, undefined, "DELETE").catch((e) => console.error("group delete failed", e));
}

/** After a STOP (in the group or one-on-one): close the group and let the other parent know. */
export async function closeGroupAfterStop(who: "alex" | "sam"): Promise<void> {
  if (!(await getGroup())) return;
  await closeGroup();
  const other = who === "alex" ? "sam" : "alex";
  if ((await getSmsOptIn(other)) !== "enrolled") return;
  const name = who === "alex" ? "Alex" : "Sam";
  await sendSms(phoneFor(other), `${name} opted out of texts from me, so I closed our family group text. I'll keep texting you one-on-one, and the Family chat in the app works as always.`).catch(() => {});
}

/** Download photos/PDFs from a group message (Conversations stores media in its own service). */
export async function fetchGroupMedia(chatServiceSid: string, mediaJson: string): Promise<FetchedMedia[]> {
  let list: { Sid?: string; ContentType?: string; Size?: number }[] = [];
  try {
    list = JSON.parse(mediaJson || "[]");
  } catch {
    return [];
  }
  const out: FetchedMedia[] = [];
  for (const m of list.slice(0, 4)) {
    const type = (m.ContentType || "").toLowerCase();
    if (!m.Sid || !MEDIA_OK.test(type)) continue;
    // The media record links to a short-lived direct URL (which must be fetched without our auth header).
    const meta = await fetch(`https://mcs.us1.twilio.com/v1/Services/${chatServiceSid}/Media/${m.Sid}`, { headers: { authorization: twilioAuth() } })
      .then((r) => (r.ok ? (r.json() as Promise<{ links?: { content_direct_temporary?: string } }>) : null))
      .catch(() => null);
    const url = meta?.links?.content_direct_temporary;
    if (!url) continue;
    const got = await readMedia(await fetch(url).catch(() => null), type);
    if (got) out.push(got);
  }
  return out;
}

/**
 * Was this "one-on-one" text really a group message? Twilio hands a group text to the group
 * AND to the number's ordinary SMS webhook, and the SMS webhook can't see the other recipients.
 * So look in the group for the same sender and words in the last two minutes (retrying briefly,
 * since the group copy can land a moment later).
 */
export async function postedToGroup(from: string, text: string): Promise<boolean> {
  const g = await getGroup();
  if (!g) return false;
  const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    const r = await tw<{ messages?: { author?: string; body?: string | null; date_created?: string }[] }>(`/Conversations/${g.sid}/Messages?Order=desc&PageSize=10`).catch(() => null);
    const hit = r?.messages?.some(
      (m) => digits(m.author || "") === digits(from) && Date.now() - Date.parse(m.date_created || "") < 120_000 && norm(m.body || "") === norm(text)
    );
    if (hit) return true;
  }
  return false;
}

export interface GroupLine {
  sid: string;
  who: "Alex" | "Sam" | "Kimi";
  text: string;
  at: string;
}

/** The last few messages in the group, oldest first (for judging whether a new one is for Kimi). */
export async function recentGroupMessages(limit = 8): Promise<GroupLine[]> {
  const g = await getGroup();
  if (!g) return [];
  const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  const r = await tw<{ messages?: { sid: string; author?: string; body?: string | null; date_created?: string }[] }>(`/Conversations/${g.sid}/Messages?Order=desc&PageSize=${limit}`).catch(() => null);
  return (r?.messages || [])
    .map((m) => {
      const a = m.author || "";
      const who = a === KIMI_IDENTITY ? "Kimi" : digits(a) === digits(phoneFor("alex")) ? "Alex" : digits(a) === digits(phoneFor("sam")) ? "Sam" : null;
      return who ? { sid: m.sid, who, text: (m.body || "").replace(/^Kimi \(Family HQ\):\s*/, ""), at: m.date_created || "" } : null;
    })
    .filter((x): x is GroupLine => !!x)
    .reverse();
}
