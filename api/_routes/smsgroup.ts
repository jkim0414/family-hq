import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { validTwilioSignature, SMS_HELP, OPT_OUT_WORDS } from "../_lib/twilio.js";
import { groupForSid, sendGroup, fetchGroupMedia, closeGroupAfterStop, KIMI_IDENTITY } from "../_lib/groupsms.js";
import { redis } from "../_lib/db.js";
import { userForPhone, smsConfigured, getSmsOptIn, setSmsOptIn } from "../_lib/notify.js";
import { converse } from "../_lib/agent.js";
import { coalesce } from "../_lib/coalesce.js";
import { pendingFor, pickPending, decideAction } from "../_lib/actions.js";
import { parseReactionText } from "../_lib/reactions.js";
import { handleReaction } from "../_lib/tapbacks.js";
import { isParent, memberName, threadMembers } from "../_lib/privacy.js";
import type { Member } from "../../src/data/types";

// POST /api/sms/group — Twilio Conversations webhook (onMessageAdded) for the group texts. Each
// shared chat has one (the parents' family chat, each parent with Grandma, everyone); a message goes
// to that chat. Every message is for Kimi: she answers, reacts, or both, as in a one-on-one text.
// Every photo or PDF is filed.

// Phones send a photo and its words as two texts ("[screenshot]", then "please file"), in either
// order. A photo without words waits briefly for its words; words that promise a photo ("file
// this") wait briefly for the photo. Otherwise each is handled on its own.
const PHOTO_KEY = "group_photo_pending";
const ASK_KEY = "group_ask_pending";
const PHOTO_WAIT_MS = 45_000; // a wordless photo waits this long for its note, then is filed as is
const ASK_WAIT_MS = 3 * 60 * 1000; // "file this" pairs with a photo arriving this soon after
const PHOTO_COMING_RE = /\b(photo|pic|picture|screenshot|image|attached|flyer|invite|(file|add|save) (this|these|it))\b/i;
type PendingPhoto = { at: string; who: Member; chatServiceSid: string; media: string };
type PendingAsk = { at: string; who: Member; text: string };
const fresh = (at: string, ms: number) => Date.now() - Date.parse(at) < ms;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A group photo (or PDF) goes to Kimi with the words that came with it: she files it, or uses it for what was asked. */
async function fileFromGroup(thread: string, who: Member, text: string, chatServiceSid: string, media: string): Promise<void> {
  const files = await fetchGroupMedia(chatServiceSid, media);
  if (!files.length) return void (await sendGroup(thread, "I couldn't open that attachment. Send a photo (JPEG or PNG) or a PDF, or add it in Family HQ."));
  const { reply } = await withThread(() => converse(thread, who, "group", text, Date.now() + 200_000, { attachments: files }));
  if (reply) await sendGroup(thread, reply);
}

/** The chat may be mid-turn (the app, a schedule); wait a little for it. */
async function withThread<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!String(e).includes("busy") || i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("POST only");
  if (!smsConfigured()) return res.status(503).send("SMS not configured");
  if (!validTwilioSignature(req)) return res.status(403).send("bad signature");
  const ok = () => res.status(200).send(""); // Conversations only needs a 2xx
  const body = (req.body || {}) as Record<string, string>;
  if (body.EventType !== "onMessageAdded" || body.Author === KIMI_IDENTITY) return ok();
  // Which chat this group text is, and whether the sender is in it.
  const found = await groupForSid(body.ConversationSid || "");
  if (!found) return ok();
  const thread = found.thread;
  const who = userForPhone(body.Author || "");
  if (!who || !threadMembers(thread).includes(who) || (await getSmsOptIn(who)) !== "enrolled") return ok();
  const name = memberName(who);
  const photoKey = `${PHOTO_KEY}:${thread}`;
  const askKey = `${ASK_KEY}:${thread}`;
  const text = (body.Body || "").trim();
  const word = text.toUpperCase().replace(/[^A-Z]/g, "");

  waitUntil(
    (async () => {
      try {
        // Keywords work here too: STOP ends Kimi's texts to that parent (and so the group); HELP is the registered reply.
        if (OPT_OUT_WORDS.includes(word)) {
          await setSmsOptIn(who, "stopped");
          await closeGroupAfterStop(who);
          return;
        }
        if (word === "HELP" || word === "INFO") {
          await sendGroup(thread, SMS_HELP);
          return;
        }

        // Approve / decline by text — in a group only as the whole message, so "ok, see you at 5"
        // between the parents never approves anything.
        // Only this group's own approvals: an APPROVE here never acts on (or announces) one from another chat.
        const said = text.trim().match(/^(approve|decline)(?:\s+#?(\d{4}))?[.!]?$/i);
        if (isParent(who) && said) {
          const { action: pending, ask } = pickPending(await pendingFor(who, thread), said[2]);
          if (!pending) return void (await sendGroup(thread, ask!));
          const a = await decideAction(pending.id, /^approve/i.test(said[1]) ? "approve" : "decline", who);
          const msg = a.status === "executed" ? `✅ ${a.title} — ${a.result}` : a.status === "declined" ? `Declined: ${a.title}` : `⚠️ ${a.title} failed: ${a.error}`;
          await sendGroup(thread, `${msg} (${name})`);
          return;
        }

        // A tapback (`Liked “…”`) goes on the message it quotes; only a 👍 on Kimi's latest offer gets a reply.
        const tap = parseReactionText(text);
        if (tap) {
          const { reply } = await withThread(() => handleReaction(thread, who, "group", tap));
          if (reply) await sendGroup(thread, reply);
          return;
        }

        const media = body.Media && body.Media !== "[]" ? body.Media : "";
        const chatServiceSid = body.ChatServiceSid || "";

        if (media) {
          // Words came with it: file it with them.
          if (text) return void (await fileFromGroup(thread, who, text, chatServiceSid, media));
          // "File this" came just before: it's that.
          const ask = await redis.get<PendingAsk>(askKey).catch(() => null);
          if (ask && ask.who === who && fresh(ask.at, ASK_WAIT_MS)) {
            await redis.del(askKey);
            return void (await fileFromGroup(thread, who, ask.text, chatServiceSid, media));
          }
          // No words yet: give them a moment to arrive, then file it as is.
          const mine: PendingPhoto = { at: new Date().toISOString(), who, chatServiceSid, media };
          await redis.set(photoKey, mine, { ex: 300 });
          await sleep(PHOTO_WAIT_MS);
          const still = await redis.get<PendingPhoto>(photoKey).catch(() => null);
          if (!still || still.at !== mine.at) return; // its words arrived and filed it
          await redis.del(photoKey);
          return void (await fileFromGroup(thread, who, "", chatServiceSid, media));
        }

        // The words for a photo sent a moment ago: file that photo with them.
        const photo = await redis.get<PendingPhoto>(photoKey).catch(() => null);
        if (photo && photo.who === who && fresh(photo.at, PHOTO_WAIT_MS + 15_000)) {
          await redis.del(photoKey);
          return void (await fileFromGroup(thread, who, text, photo.chatServiceSid, photo.media));
        }

        // "File this" with the photo still on its way: give it a few seconds to land.
        if (PHOTO_COMING_RE.test(text)) {
          const ask: PendingAsk = { at: new Date().toISOString(), who, text };
          await redis.set(askKey, ask, { ex: Math.round(ASK_WAIT_MS / 1000) });
          await sleep(8000);
          const still = await redis.get<PendingAsk>(askKey).catch(() => null);
          if (!still || still.at !== ask.at) return; // the photo arrived and was filed with these words
        }

        // Several texts in a row from one person: answer them once, together.
        const whole = await coalesce(`group:${thread}:${who}`, text);
        if (whole === null) return;
        const { reply } = await withThread(() => converse(thread, who, "group", whole, Date.now() + 200_000));
        if (reply) await sendGroup(thread, reply);
      } catch (e) {
        console.error("group text failed", e);
        if (String(e).includes("busy")) await sendGroup(thread, "One sec, I'm mid-task. Ask me again in a minute.").catch(() => {});
      }
    })()
  );
  ok();
}
