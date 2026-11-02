import { converse } from "./agent.js";
import { findQuoted, setReaction, latestKimi, isApprovalRequest, YES_EMOJI, type ParsedReaction } from "./reactions.js";
import type { Channel, TaskLogEntry, Member } from "../../src/data/types";

/**
 * A parent reacted to a message (a tapback by text, or in the app). Record it on the message;
 * a 👍 / ❤️ / ‼️ on Kimi's latest offer ("Want me to book it?") is a yes, so she carries on and
 * her reply is returned. Anything else is quiet — no reply. Never counts as an approval.
 */
export async function handleReaction(
  threadId: string,
  who: Member,
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
  if (!mine || !YES_EMOJI.has(mine) || entry.kind !== "assistant" || isApprovalRequest(entry)) return { reply: "", matched: true };
  const latest = await latestKimi(threadId);
  if (!latest || latest.at !== entry.at) return { reply: "", matched: true };
  // Whether it's a yes depends on what the message said ("just say the word" offers without a "?";
  // a ❤️ on "Swim moved to 4?" might just be thanks): Kimi reads it, and says nothing if it's only that.
  const excerpt = entry.text.replace(/\s+/g, " ").slice(-240);
  const { reply } = await converse(threadId, who, channel, `${mine} (a tapback on your message "…${excerpt}". If that message offered to do something or asked a yes/no question, this is a yes: go ahead. If it was just information, it's an acknowledgment: reply with nothing.)`, deadlineMs, { log: false, silentOk: true });
  return { reply, matched: true };
}
