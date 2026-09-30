import { redis } from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Private threads. Each parent has a "Just me" conversation with Kimi (the app's
// Chat → Just me, and their one-on-one texts); the family chat (and a future
// group text) is shared. Anything filed from a private thread can be private
// too — an event, a to-do, an approval, a purchase, a schedule, a file, a note —
// and is then visible only to that parent: never in the family chat, the shared
// digests, the other parent's app, or the shared Google Calendar.
// ─────────────────────────────────────────────────────────────────────────────

export type Parent = "alex" | "sam";
/** Who is looking: a parent in the app (sees shared + their own private), or a thread. */
export type Viewer = Parent | "family";

export const privateThreadId = (p: Parent) => `task-private-${p}`;
export function threadOwner(taskId: string): Parent | null {
  const m = taskId.match(/^task-private-(alex|sam)$/);
  return m ? (m[1] as Parent) : null;
}

/** Shared items are visible to everyone; private items only to their owner. */
export function canSee(item: { privateTo?: Parent } | null | undefined, viewer: Viewer): boolean {
  return !!item && (!item.privateTo || item.privateTo === viewer);
}

// Private notes: what a parent asked Kimi to remember just for them (e.g. a gift idea).
const notesKey = (p: Parent) => `private_notes:${p}`;
export async function getPrivateNotes(p: Parent): Promise<string[]> {
  return (await redis.get<string[]>(notesKey(p)).catch(() => null)) || [];
}
export async function addPrivateNote(p: Parent, note: string): Promise<void> {
  const notes = await getPrivateNotes(p);
  notes.push(note);
  await redis.set(notesKey(p), notes.slice(-200));
}
