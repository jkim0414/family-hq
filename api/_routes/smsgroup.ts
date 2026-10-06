import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { validTwilioSignature, SMS_HELP, OPT_OUT_WORDS } from "../_lib/twilio.js";
import { getGroup, sendGroup, fetchGroupMedia, closeGroupAfterStop, KIMI_IDENTITY } from "../_lib/groupsms.js";
import { redis } from "../_lib/db.js";
import { userForPhone, smsConfigured, getSmsOptIn, setSmsOptIn } from "../_lib/notify.js";
import { converse, appendExchange, MAIN_TASK_ID } from "../_lib/agent.js";
import { runCapture, describeCapture } from "../_lib/capture.js";
import { latestPending, decideAction } from "../_lib/actions.js";
import { parseReactionText } from "../_lib/reactions.js";
import { handleReaction } from "../_lib/tapbacks.js";

// POST /api/sms/group — Twilio Conversations webhook (onMessageAdded) for the family
// group text. The group is Alex, Sam, and Kimi — the parents talk privately in their own
// thread — so every message here is for Kimi: it goes to the family chat and she answers,
// reacts, or both, as in a one-on-one text. Every photo or PDF is filed.

// Phones send a photo and its words as two texts ("[screenshot]", then "please file"), in either
// order. A photo without words waits briefly for its words; words that promise a photo ("file
// this") wait briefly for the photo. Otherwise each is handled on its own.
const PHOTO_KEY = "group_photo_pending";
const ASK_KEY = "group_ask_pending";
const PHOTO_WAIT_MS = 45_000; // a wordless photo waits this long for its note, then is filed as is
const ASK_WAIT_MS = 3 * 60 * 1000; // "file this" pairs with a photo arriving this soon after
const PHOTO_COMING_RE = /\b(photo|pic|picture|screenshot|image|attached|flyer|invite|(file|add|save) (this|these|it))\b/i;
type PendingPhoto = { at: string; who: "alex" | "sam"; chatServiceSid: string; media: string };
type PendingAsk = { at: string; who: "alex" | "sam"; text: string };
const fresh = (at: string, ms: number) => Date.now() - Date.parse(at) < ms;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** File a group photo (or PDF) with the words that came with it, and say what was filed. */
async function fileFromGroup(who: "alex" | "sam", text: string, chatServiceSid: string, media: string, note = "by group text"): Promise<void> {
  const files = await fetchGroupMedia(chatServiceSid, media);
  if (!files.length) return void (await sendGroup("I couldn't open that attachment. Send a photo (JPEG or PNG) or a PDF, or add it in Family HQ."));
  const reply = describeCapture(await runCapture({ text, images: files }));
  await withThread(() => appendExchange(MAIN_TASK_ID, who, "group", `${text || "(no note)"}\n📎 ${files.length} ${files.length === 1 ? "attachment" : "attachments"} ${note}`, reply));
  await sendGroup(reply);
}

/** The family thread may be mid-turn (the app, a schedule); wait a little for it. */
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
  const g = await getGroup();
  if (!g || body.ConversationSid !== g.sid) return ok();
  const who = userForPhone(body.Author || "");
  if (!who || (await getSmsOptIn(who)) !== "enrolled") return ok();
  const name = who === "alex" ? "Alex" : "Sam";
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
          await sendGroup(SMS_HELP);
          return;
        }

        // Approve / decline by text — in a group only as the whole message, so "ok, see you at 5"
        // between the parents never approves anything.
        if (/^(approve|decline)$/i.test(text)) {
          const pending = await latestPending(who);
          if (!pending) return void (await sendGroup("Nothing is waiting for approval right now."));
          const a = await decideAction(pending.id, /^approve/i.test(text) ? "approve" : "decline", who);
          const msg = a.status === "executed" ? `✅ ${a.title} — ${a.result}` : a.status === "declined" ? `Declined: ${a.title}` : `⚠️ ${a.title} failed: ${a.error}`;
          await sendGroup(`${msg} (${name})`);
          return;
        }

        // A tapback (`Liked “…”`) goes on the message it quotes; only a 👍 on Kimi's latest offer gets a reply.
        const tap = parseReactionText(text);
        if (tap) {
          const { reply } = await withThread(() => handleReaction(MAIN_TASK_ID, who, "group", tap));
          if (reply) await sendGroup(reply);
          return;
        }

        const media = body.Media && body.Media !== "[]" ? body.Media : "";
        const chatServiceSid = body.ChatServiceSid || "";

        if (media) {
          // Words came with it: file it with them.
          if (text) return void (await fileFromGroup(who, text, chatServiceSid, media));
          // "File this" came just before: it's that.
          const ask = await redis.get<PendingAsk>(ASK_KEY).catch(() => null);
          if (ask && ask.who === who && fresh(ask.at, ASK_WAIT_MS)) {
            await redis.del(ASK_KEY);
            return void (await fileFromGroup(who, ask.text, chatServiceSid, media, "sent just after"));
          }
          // No words yet: give them a moment to arrive, then file it as is.
          const mine: PendingPhoto = { at: new Date().toISOString(), who, chatServiceSid, media };
          await redis.set(PHOTO_KEY, mine, { ex: 300 });
          await sleep(PHOTO_WAIT_MS);
          const still = await redis.get<PendingPhoto>(PHOTO_KEY).catch(() => null);
          if (!still || still.at !== mine.at) return; // its words arrived and filed it
          await redis.del(PHOTO_KEY);
          return void (await fileFromGroup(who, "", chatServiceSid, media));
        }

        // The words for a photo sent a moment ago: file that photo with them.
        const photo = await redis.get<PendingPhoto>(PHOTO_KEY).catch(() => null);
        if (photo && photo.who === who && fresh(photo.at, PHOTO_WAIT_MS + 15_000)) {
          await redis.del(PHOTO_KEY);
          return void (await fileFromGroup(who, text, photo.chatServiceSid, photo.media, "sent just before"));
        }

        // "File this" with the photo still on its way: give it a few seconds to land.
        if (PHOTO_COMING_RE.test(text)) {
          const ask: PendingAsk = { at: new Date().toISOString(), who, text };
          await redis.set(ASK_KEY, ask, { ex: Math.round(ASK_WAIT_MS / 1000) });
          await sleep(8000);
          const still = await redis.get<PendingAsk>(ASK_KEY).catch(() => null);
          if (!still || still.at !== ask.at) return; // the photo arrived and was filed with these words
        }

        const { reply } = await withThread(() => converse(MAIN_TASK_ID, who, "group", text, Date.now() + 200_000));
        if (reply) await sendGroup(reply);
      } catch (e) {
        console.error("group text failed", e);
        if (String(e).includes("busy")) await sendGroup("One sec, I'm mid-task. Ask me again in a minute.").catch(() => {});
      }
    })()
  );
  ok();
}
