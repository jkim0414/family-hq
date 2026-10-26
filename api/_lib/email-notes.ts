import { CONFIG } from "../../src/data/config.js";
import { senderAddress } from "./senders.js";
import { privateThreadId, isParent, PARENTS } from "./privacy.js";
import type { RawMessage } from "./imap.js";
import type { Member } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// An email from someone in the family to Kimi's inbox that isn't a forward — a reply to one of her
// emails ("all set, we did that already"), a note with a PDF — is them talking
// to Kimi, like a text: it goes to her as a message (she can check off a to-do, drop an event,
// answer), not to filing. Forwards ("Fwd:") are still filed.
// ─────────────────────────────────────────────────────────────────────────────

const MAIN = "task-main";
const emails = (): Record<string, Member> => {
  const out: Record<string, Member> = {};
  for (const [id, p] of Object.entries(CONFIG.parents)) if (p.email) out[p.email.toLowerCase()] = id as Member;
  for (const [id, c] of Object.entries(CONFIG.caregivers || {})) if ((c as { email?: string }).email) out[(c as { email: string }).email.toLowerCase()] = id as Member;
  return out;
};
const FORWARD_RE = /^\s*(fwd?|fw)\s*:/i;
const FORWARDED_BODY_RE = /(begin forwarded message|-{3,}\s*forwarded message\s*-{3,})/i;

/** Who in the family wrote this to Kimi (not a forward), or null. */
export function noteFrom(m: RawMessage): Member | null {
  const who = emails()[senderAddress(m.from)];
  // A From line can be forged: only mail Gmail authenticated as really from them speaks for them.
  if (!who || !m.fromVerified) return null;
  if (FORWARD_RE.test(m.subject) || FORWARDED_BODY_RE.test(m.text.slice(0, 3000))) return null;
  return who;
}

/** The chat it belongs in: the parents' chat when the other parent is on it, else the sender's own. */
export function noteThread(who: Member, m: RawMessage): string {
  if (!isParent(who)) return privateThreadId(who);
  const other = PARENTS.find((p) => p !== who)!;
  const otherEmail = CONFIG.parents[other]?.email?.toLowerCase();
  return otherEmail && (m.recipients || []).includes(otherEmail) ? MAIN : privateThreadId(who);
}

/** What they wrote, with what they were replying to (trimmed) for context. */
export function noteText(m: RawMessage): string {
  const cut = m.text.search(/\n\s*(On .{5,250}wrote:|-{3,}\s*Original Message|From: .+\n\s*(Sent|Date): )/i);
  const own = (cut >= 0 ? m.text.slice(0, cut) : m.text).replace(/\n*Sent from my (iPhone|iPad|phone)\s*$/i, "").trim();
  const quoted = cut >= 0 ? m.text.slice(cut).replace(/^\s*>+ ?/gm, "").replace(/\s+/g, " ").trim().slice(0, 800) : "";
  return `(by email to your inbox — subject "${m.subject}")\n${own || "(no note)"}${quoted ? `\n\n[replying to: ${quoted}]` : ""}`;
}
