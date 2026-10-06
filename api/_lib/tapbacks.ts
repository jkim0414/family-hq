import { converse } from "./agent.js";
import { findQuoted, setReaction, latestKimi, isOffer, YES_EMOJI, type ParsedReaction } from "./reactions.js";
import type { Channel, TaskLogEntry } from "../../src/data/types";

/**
 * A parent reacted to a message (a tapback by text, or in the app). Record it on the message;
 * a 👍 / ❤️ / ‼️ on Kimi's latest offer ("Want me to book it?") is a yes, so she carries on and
 * her reply is returned. Anything else is quiet — no reply. Never counts as an approval.
 */
export async function handleReaction(
  threadId: string,
  who: "alex" | "sam",
  channel: Channel,
  target: TaskLogEntry | ParsedReaction,
  emojiIfEntry?: string | null,
  deadlineMs = Date.now() + 200_000
): Promise<{ reply: string; matched: boolean }> {
  const entry = "kind" in target ? target : await findQuoted(threadId, target.quoted);
  const emoji = "kind" in target ? emojiIfEntry ?? null : target.emoji;
  if (!entry) return { reply: "", matched: false };
  const now = await setReaction(threadId, entry, who, emoji, { toggle: "kind" in target });
  const mine = now.find((r) => r.by === who)?.emoji;
  if (!mine || !YES_EMOJI.has(mine) || !isOffer(entry)) return { reply: "", matched: true };
  const latest = await latestKimi(threadId);
  if (!latest || latest.at !== entry.at) return { reply: "", matched: true };
  const excerpt = entry.text.replace(/\s+/g, " ").slice(-160);
  const { reply } = await converse(threadId, who, channel, `${mine} (a tapback on your message "…${excerpt}" — they're saying yes to what you offered)`, deadlineMs, { log: false });
  return { reply, matched: true };
}
