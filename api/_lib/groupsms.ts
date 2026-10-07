import { redis } from "./db.js";
import { twilioAuth, readMedia, MEDIA_OK, type FetchedMedia } from "./twilio.js";
import { smsBody, sendSms, getSmsOptIn, phoneFor, smsConfigured, tapbackText, textable } from "./notify.js";
import { memberName } from "./privacy.js";
import { MEMBERS, MAIN_THREAD, threadsFor, threadMembers } from "../../src/data/threads.js";
import type { Member } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Group texts: every shared chat (two or more members — the parents' family chat, each parent
// with Grandma, and everyone) gets its own group text once everyone in it has opted in.
// A phone number can't join a group text by itself, so each is a Twilio Conversations
// "Group MMS" conversation: each member is an SMS participant and Kimi is a participant
// projected onto her number, so her messages come from it. Twilio tells the groups apart by who
// is in them, and only routes a text to a group when the whole set of people matches — so
// one-on-one texts still reach /api/sms. Group messages reach /api/sms/group (a conversation
// webhook) and go to that chat in the app. US numbers only, green-bubble MMS, max 10 people.
// ─────────────────────────────────────────────────────────────────────────────

const API = "https://conversations.twilio.com/v1";
const KEY = "sms_groups"; // hash: chat thread id → Group
const LEGACY_KEY = "sms_group"; // the first family group, from before shared chats
export const KIMI_IDENTITY = "kimi";
export const KIMI_NUMBER = process.env.TWILIO_FROM || "+15550100100";
const WEBHOOK_URL = `${process.env.APP_URL || "https://your-app.vercel.app"}/api/sms/group`;

/** Chats that get a group text: every shared one. */
const SHARED_THREADS = [...new Set(MEMBERS.flatMap(threadsFor))].filter((t) => (threadMembers(t) || []).length >= 2);

export interface Group {
  sid: string;
  createdAt: string;
}

async function tw<T = Record<string, unknown>>(path: string, form?: Record<string, string> | URLSearchParams, method = form ? "POST" : "GET"): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: twilioAuth(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (!res.ok) throw new Error(`Twilio Conversations ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? {} : await res.json()) as T;
}

/** Every group text, by chat thread (the original family group is carried over once). */
export async function getGroups(): Promise<Record<string, Group>> {
  const all = ((await redis.hgetall<Record<string, Group>>(KEY).catch(() => null)) || {}) as Record<string, Group>;
  if (!all[MAIN_THREAD]) {
    const legacy = await redis.get<Group>(LEGACY_KEY).catch(() => null);
    if (legacy?.sid) {
      all[MAIN_THREAD] = legacy;
      await redis.hset(KEY, { [MAIN_THREAD]: legacy });
      await redis.del(LEGACY_KEY);
    }
  }
  return all;
}

export async function getGroup(thread = MAIN_THREAD): Promise<Group | null> {
  return (await getGroups())[thread] ?? null;
}

/** Which chat a Twilio conversation is. */
export async function groupForSid(sid: string): Promise<{ thread: string; group: Group } | null> {
  const all = await getGroups();
  const thread = Object.keys(all).find((t) => all[t].sid === sid);
  return thread ? { thread, group: all[thread] } : null;
}

function intro(thread: string): string {
  const ms = threadMembers(thread) || [];
  const names = ms.map(memberName);
  const who = names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  if (thread === MAIN_THREAD)
    return `Hi ${who}! 👋 This is our family group text. Talk to each other here like normal. When you want me, just say "Kimi" ("Kimi, add swim Tuesday at 4") and I'll answer here for both of you. Everything here also shows up in the Family chat in the app.`;
  return `Hi ${who}! 👋 This is our group text, just the ${ms.length + 1} of us. Ask me anything here and I'll answer for everyone in it. It shows up in your shared chat in the app too.`;
}

/**
 * Create the group text for every shared chat whose members have all opted in (and that doesn't
 * have one yet), and say hello. Safe to call any time; returns the chats it created groups for.
 */
export async function ensureGroups(): Promise<string[]> {
  if (!smsConfigured()) return [];
  const existing = await getGroups();
  const made: string[] = [];
  for (const thread of SHARED_THREADS) {
    if (existing[thread]) continue;
    const ms = threadMembers(thread) || [];
    if (!ms.every(textable)) continue;
    const states = await Promise.all(ms.map(getSmsOptIn));
    if (!states.every((x) => x === "enrolled")) continue;
    if (await createGroup(thread, ms)) made.push(thread);
  }
  return made;
}

async function createGroup(thread: string, ms: Member[]): Promise<boolean> {
  if (!(await redis.set(`${KEY}_lock:${thread}`, "1", { nx: true, ex: 60 }))) return false;
  let sid = "";
  try {
    // Everyone joins at once: Twilio refuses a group whose people match an existing one, and adding
    // them one by one would pass through a pair that already has its own group (e.g. Alex & Sam).
    const form = new URLSearchParams({ FriendlyName: "Family HQ" });
    // Send through the registered A2P campaign's Messaging Service.
    if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
    form.append("Participant", JSON.stringify({ identity: KIMI_IDENTITY, messaging_binding: { projected_address: KIMI_NUMBER } }));
    for (const m of ms) form.append("Participant", JSON.stringify({ messaging_binding: { address: phoneFor(m) } }));
    const conv = await tw<{ sid: string }>("/ConversationWithParticipants", form);
    sid = conv.sid;
    // A conversation created with its participants takes a few seconds to initialize; until then
    // Twilio refuses changes (50386). Retry those for up to ~40s.
    const ready = async <T,>(fn: () => Promise<T>): Promise<T> => {
      for (let i = 0; ; i++) {
        try {
          return await fn();
        } catch (e) {
          if (!String(e).includes("50386") || i >= 12) throw e;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    await ready(() => tw(`/Conversations/${sid}/Webhooks`, {
      Target: "webhook",
      "Configuration.Url": WEBHOOK_URL,
      "Configuration.Method": "POST",
      "Configuration.Filters": "onMessageAdded",
    }));
    await ready(() => tw(`/Conversations/${sid}/Messages`, { Author: KIMI_IDENTITY, Body: smsBody(intro(thread)).slice(0, 1500) }));
    // Recorded only once it's fully set up, so a failure leaves nothing pointing at a deleted group.
    await redis.hset(KEY, { [thread]: { sid, createdAt: new Date().toISOString() } satisfies Group });
    return true;
  } catch (e) {
    if (sid) await tw(`/Conversations/${sid}`, undefined, "DELETE").catch(() => {});
    console.error(`group text for ${thread} failed`, e);
    return false;
  } finally {
    await redis.del(`${KEY}_lock:${thread}`).catch(() => {});
  }
}

/** Kimi says something in a chat's group text (branded, plain text, HQ links only — like every text). */
export async function sendGroup(thread: string, raw: string): Promise<boolean> {
  const g = await getGroup(thread);
  if (!g) return false;
  const body = smsBody(raw).slice(0, 1500);
  await tw(`/Conversations/${g.sid}/Messages`, { Author: KIMI_IDENTITY, Body: body });
  return true;
}

/**
 * Kimi reacts to a message in a group the way a phone does (`Liked “…”`). Group MMS keeps the
 * curly quotes, so iPhones show it as a tapback on that bubble (tested on iOS).
 */
export async function sendGroupReaction(thread: string, emoji: string, quoted: string): Promise<boolean> {
  const g = await getGroup(thread);
  const body = tapbackText(emoji, quoted);
  if (!g || !body) return false;
  await tw(`/Conversations/${g.sid}/Messages`, { Author: KIMI_IDENTITY, Body: body });
  return true;
}

/** Tear a group down (someone in it opted out — Kimi can't text them anymore). */
export async function closeGroup(thread: string): Promise<void> {
  const g = await getGroup(thread);
  if (!g) return;
  await redis.hdel(KEY, thread);
  await tw(`/Conversations/${g.sid}`, undefined, "DELETE").catch((e) => console.error("group delete failed", e));
}

/** After a STOP (in a group or one-on-one): close every group they're in and tell the others in them. */
export async function closeGroupAfterStop(who: Member): Promise<void> {
  const all = await getGroups();
  const theirs = Object.keys(all).filter((t) => (threadMembers(t) || []).includes(who));
  if (!theirs.length) return;
  const others = new Set<Member>();
  for (const t of theirs) {
    await closeGroup(t);
    for (const m of threadMembers(t) || []) if (m !== who) others.add(m);
  }
  for (const m of others) {
    if (!textable(m) || (await getSmsOptIn(m)) !== "enrolled") continue;
    await sendSms(phoneFor(m), `${memberName(who)} opted out of texts from me, so I closed our group text with them. I'll keep texting you one-on-one, and the chat in the app works as always.`).catch(() => {});
  }
}

/** Download photos/PDFs from a group message (Conversations stores media in its own service). */
export async function fetchGroupMedia(chatServiceSid: string, mediaJson: string): Promise<FetchedMedia[]> {
  // Webhooks send {Sid, ContentType}; the REST API sends {sid, content_type}. Accept both.
  let list: { Sid?: string; sid?: string; ContentType?: string; content_type?: string }[] = [];
  try {
    list = JSON.parse(mediaJson || "[]");
  } catch {
    return [];
  }
  const out: FetchedMedia[] = [];
  for (const m of list.slice(0, 4)) {
    const sid = m.Sid || m.sid;
    const type = (m.ContentType || m.content_type || "").toLowerCase();
    if (!sid || !MEDIA_OK.test(type)) continue;
    // The media record links to a short-lived direct URL (which must be fetched without our auth header).
    const meta = await fetch(`https://mcs.us1.twilio.com/v1/Services/${chatServiceSid}/Media/${sid}`, { headers: { authorization: twilioAuth() } })
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
export async function postedToGroup(from: string, text: string, who?: Member | null): Promise<boolean> {
  const all = await getGroups();
  const sids = Object.keys(all).filter((t) => !who || (threadMembers(t) || []).includes(who)).map((t) => all[t].sid);
  if (!sids.length) return false;
  const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    for (const sid of sids) {
      const r = await tw<{ messages?: { author?: string; body?: string | null; date_created?: string }[] }>(`/Conversations/${sid}/Messages?Order=desc&PageSize=10`).catch(() => null);
      const hit = r?.messages?.some(
        (m) => digits(m.author || "") === digits(from) && Date.now() - Date.parse(m.date_created || "") < 120_000 && norm(m.body || "") === norm(text)
      );
      if (hit) return true;
    }
  }
  return false;
}
