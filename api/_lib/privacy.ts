import { redis } from "./db.js";
import { CONFIG } from "../../src/data/config.js";
import type { Member, ParentId } from "../../src/data/types";
import { threadMembers as membersOfThread } from "../../src/data/threads.js";

// ─────────────────────────────────────────────────────────────────────────────
// Private threads. Each member (parents, and the caregiver) has a "Just me" conversation with Kimi (the app's
// Chat → Just me, and their one-on-one texts); the family chat (and a future
// group text) is shared. Anything filed from a private thread can be private
// too — an event, a to-do, an approval, a purchase, a schedule, a file, a note —
// and is then visible only to that parent: never in the family chat, the shared
// digests, the other parent's app, or the shared Google Calendar.
// ─────────────────────────────────────────────────────────────────────────────

export type Parent = ParentId;
export type { Member };
/** Who is looking: a member in the app (sees shared + their own private), or a thread. */
export type Viewer = Member | "family";

export const PARENTS: Parent[] = ["alex", "sam"];
export const isParent = (id: string | null | undefined): id is Parent => id === "alex" || id === "sam";
/** Display name: what the family (and Kimi) call each member. */
export const memberName = (m: Member): string => (m === "alex" ? "Alex" : m === "sam" ? "Sam" : CONFIG.caregivers.grandma.callMe);

export const privateThreadId = (m: Member) => `task-private-${m}`;
export function threadOwner(taskId: string): Member | null {
  const mm = taskId.match(/^task-private-(alex|sam|grandma)$/);
  return mm ? (mm[1] as Member) : null;
}

/** Who is in a chat thread (see src/data/threads.ts); anything else is treated as the parents'. */
export function threadMembers(taskId: string): Member[] {
  return membersOfThread(taskId) ?? [...PARENTS];
}

const viewers = (v: Viewer): Member[] => (v === "family" ? [...PARENTS] : [v]);

/** Shared items are visible to everyone; private ones only to their owner; kept-in-a-chat ones only to its members. */
export function canSee(item: { privateTo?: Member; audience?: Member[] } | null | undefined, viewer: Viewer): boolean {
  if (!item) return false;
  return viewers(viewer).every((m) => (!item.privateTo || item.privateTo === m) && (!item.audience || item.audience.includes(m)));
}

/** On the shared Google Calendar (whose invites reach both parents): only what both parents may see. */
export const onSharedCalendar = (e: { privateTo?: Member; audience?: Member[] }) => !e.privateTo && (!e.audience || PARENTS.every((p) => e.audience!.includes(p)));

/** In a chat, Kimi only uses what every member present may see. */
export function canSeeAll(item: { privateTo?: Member; audience?: Member[] } | null | undefined, members: Member[]): boolean {
  return !!item && members.every((m) => canSee(item, m));
}

/**
 * Conversation artifacts — files, browser tasks, schedules, approvals — belong to the chat they
 * came from. With an audience, exactly those members. Older ones: parents see shared ones plus
 * their own private ones; the caregiver only her own (the shared ones came from the parents' chat).
 * Calendar events and to-dos use canSee instead: they're household-wide.
 */
export function canSeeArtifact(item: { privateTo?: Member; requester?: Member; audience?: Member[] } | null | undefined, viewer: Viewer): boolean {
  if (!item) return false;
  if (item.audience) return viewers(viewer).every((m) => item.audience!.includes(m) && (!item.privateTo || item.privateTo === m));
  if (viewer === "family" || isParent(viewer)) return canSee(item, viewer);
  return item.privateTo === viewer || item.requester === viewer;
}

/** A chat thread is visible to its members; a background (browser) task follows the artifact rule. */
export function canSeeTask(t: { id: string; kind?: string; privateTo?: Member; requester?: Member; audience?: Member[] } | null | undefined, viewer: Viewer): boolean {
  if (!t) return false;
  if ((t.kind || "chat") === "chat") return viewers(viewer).every((m) => threadMembers(t.id).includes(m));
  return canSeeArtifact(t, viewer);
}

/**
 * The chat a member asked for: "private" (their Just-me chat), "family" (the parents' chat — a
 * caregiver's own instead), or a thread id they're in. null when they're not in it.
 */
export function chatFor(requested: unknown, me: Member): string | null {
  const r = typeof requested === "string" ? requested : "";
  if (!r || r === "family" || r === "task-main") return isParent(me) ? "task-main" : privateThreadId(me);
  if (r === "private") return privateThreadId(me);
  return membersOfThread(r)?.includes(me) ? r : null;
}

// Private notes: what a parent asked Kimi to remember just for them (e.g. a gift idea).
const notesKey = (p: Member) => `private_notes:${p}`;
export async function getPrivateNotes(p: Member): Promise<string[]> {
  return (await redis.get<string[]>(notesKey(p)).catch(() => null)) || [];
}
export async function addPrivateNote(p: Member, note: string): Promise<void> {
  const notes = await getPrivateNotes(p);
  notes.push(note);
  await redis.set(notesKey(p), notes.slice(-200));
}
