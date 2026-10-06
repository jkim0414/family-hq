import { redis, getTaskMeta } from "./db.js";
import { smsBody } from "./notify.js";
import type { Reaction, TaskLogEntry } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Reactions on chat messages — 👍 ❤️ 😂 ‼️ ❓ 👎. From the app (tap and hold a
// message), from a phone (a tapback on Kimi's text arrives as a plain text like
// `Liked “…”`), and from Kimi herself (the react tool). Stored beside the thread,
// not in it, so reacting never waits on a running conversation:
//   reactions:<threadId>  hash  "<entry.at>|<entry.kind>" → Reaction[]
// ─────────────────────────────────────────────────────────────────────────────

export const REACTIONS = ["👍", "❤️", "😂", "‼️", "❓", "👎"];
const KEY = (threadId: string) => `reactions:${threadId}`;
export const REACTIONS_VER = "reactions_ver"; // bumped on every change, so open chats refresh
export const entryKey = (e: Pick<TaskLogEntry, "at" | "kind">) => `${e.at}|${e.kind}`;

export async function getReactions(threadId: string): Promise<Record<string, Reaction[]>> {
  return ((await redis.hgetall<Record<string, Reaction[]>>(KEY(threadId)).catch(() => null)) || {}) as Record<string, Reaction[]>;
}

/** The log with each entry's reactions attached (for serving a thread). */
export async function withReactions(threadId: string, log: TaskLogEntry[]): Promise<TaskLogEntry[]> {
  const all = await getReactions(threadId);
  if (!Object.keys(all).length) return log;
  return log.map((e) => (all[entryKey(e)]?.length ? { ...e, reactions: all[entryKey(e)] } : e));
}

/**
 * Set (or with emoji null, remove) one person's reaction on a message. Reacting with the same
 * emoji again removes it, like a tapback. Returns the entry's reactions after the change.
 */
export async function setReaction(threadId: string, entry: Pick<TaskLogEntry, "at" | "kind">, by: Reaction["by"], emoji: string | null, opts: { toggle?: boolean } = {}): Promise<Reaction[]> {
  const field = entryKey(entry);
  const cur = ((await redis.hget<Reaction[]>(KEY(threadId), field).catch(() => null)) || []) as Reaction[];
  const mine = cur.find((r) => r.by === by);
  let next = cur.filter((r) => r.by !== by);
  if (emoji && !(opts.toggle && mine?.emoji === emoji)) next = [...next, { by, emoji, at: new Date().toISOString() }];
  if (next.length) await redis.hset(KEY(threadId), { [field]: next });
  else await redis.hdel(KEY(threadId), field);
  await redis.incr(REACTIONS_VER).catch(() => {});
  return next;
}

// ── Tapbacks that arrive as text ─────────────────────────────────────────────
// iPhone → a non-iMessage number: `Liked “…”`, `Loved “…”`, `Laughed at “…”`, `Emphasized “…”`,
// `Questioned “…”`, `Disliked “…”`, `Reacted 🙏 to “…”`, and `Removed a like from “…”` etc.
// Android (Google Messages) sends similar English forms, sometimes `👍 to "…"`.

const VERBS: Record<string, string> = { liked: "👍", loved: "❤️", disliked: "👎", "laughed at": "😂", emphasized: "‼️", questioned: "❓" };
const REMOVED: Record<string, string> = { like: "👍", heart: "❤️", dislike: "👎", laugh: "😂", exclamation: "‼️", "question mark": "❓" };
const Q = `[“"'‘]`;
const QEND = `[”"'’]?`;

export interface ParsedReaction {
  emoji: string | null; // null = the reaction was removed
  quoted: string;
}

export function parseReactionText(raw: string): ParsedReaction | null {
  const t = raw.trim();
  let m = t.match(new RegExp(`^(Liked|Loved|Disliked|Laughed at|Emphasized|Questioned) ${Q}([\\s\\S]+?)${QEND}$`, "i"));
  if (m) return { emoji: VERBS[m[1].toLowerCase()], quoted: m[2] };
  m = t.match(new RegExp(`^Removed an? (like|heart|dislike|laugh|exclamation|question mark) from ${Q}([\\s\\S]+?)${QEND}$`, "i"));
  if (m) return { emoji: null, quoted: m[2] };
  m = t.match(new RegExp(`^Reacted (\\S{1,8}) to ${Q}([\\s\\S]+?)${QEND}$`, "i"));
  if (m) return { emoji: m[1], quoted: m[2] };
  m = t.match(new RegExp(`^Removed (\\S{1,8}) from ${Q}([\\s\\S]+?)${QEND}$`, "i"));
  if (m) return { emoji: null, quoted: m[2] };
  m = t.match(new RegExp(`^(\\p{Extended_Pictographic}[\\p{Extended_Pictographic}\\u200d\\ufe0f]*) to ${Q}([\\s\\S]+?)${QEND}$`, "u"));
  if (m) return { emoji: m[1], quoted: m[2] };
  return null;
}

/** Comparable form of a message as it appeared on the phone (brand prefix, markdown, quotes, "…" gone). */
const norm = (s: string) =>
  s
    .replace(/^Kimi \([^)]*\):\s*/, "")
    .replace(/[“”"‘’']/g, "")
    .replace(/(…|\.\.\.)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Which message in this thread a tapback quotes (newest first). Kimi's are compared as they were texted. */
export async function findQuoted(threadId: string, quoted: string): Promise<TaskLogEntry | null> {
  const meta = await getTaskMeta(threadId);
  const q = norm(quoted);
  if (!meta || q.length < 2) return null;
  for (const e of [...meta.log].reverse()) {
    if (e.kind !== "assistant" && e.kind !== "user") continue;
    const shown = norm(e.kind === "assistant" ? smsBody(e.text) : e.text);
    if (shown && (shown.startsWith(q) || (shown.length >= 12 && q.startsWith(shown)))) return e;
  }
  return null;
}

/** Is this Kimi message an offer or question a 👍 can say "yes" to? (Never an approval request.) */
export function isOffer(e: TaskLogEntry): boolean {
  if (e.kind !== "assistant" || /APPROVE|DECLINE|Needs your approval/.test(e.text)) return false;
  return /\?\s*(\p{Extended_Pictographic}|️|\s)*$/u.test(e.text.trim());
}

/** The newest message from Kimi in the thread (a 👍 only means "yes" on her latest offer). */
export async function latestKimi(threadId: string): Promise<TaskLogEntry | null> {
  const meta = await getTaskMeta(threadId);
  return [...(meta?.log || [])].reverse().find((e) => e.kind === "assistant") || null;
}

export const YES_EMOJI = new Set(["👍", "❤️", "‼️"]);
