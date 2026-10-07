import type { Member } from "./types";
import { personName } from "./people.js";

// ─────────────────────────────────────────────────────────────────────────────
// Chat threads are sets of members (Kimi is in every one):
//   task-private-<m>        one member's "Just me" chat (also their one-on-one texts)
//   task-main               the parents' family chat (private from the caregiver)
//   task-with-<a>-<b>[-<c>] a shared chat with the caregiver: each parent + Grandma, and everyone
// Shared by the API (who may read/write a thread) and the app (the thread switcher).
// ─────────────────────────────────────────────────────────────────────────────

export const MEMBERS: Member[] = ["alex", "sam", "grandma"];
export const PARENT_IDS: Member[] = ["alex", "sam"];
export const MAIN_THREAD = "task-main";

/** Who is in a chat thread (null: not a chat thread). */
export function threadMembers(id: string): Member[] | null {
  if (id === MAIN_THREAD) return [...PARENT_IDS];
  const priv = id.match(/^task-private-(alex|sam|grandma)$/);
  if (priv) return [priv[1] as Member];
  const shared = id.match(/^task-with-([a-z]+(?:-[a-z]+)+)$/);
  if (shared) {
    const ms = shared[1].split("-");
    // Only the canonical id for a set of members (no second "Alex & Sam" chat beside the family chat).
    if (ms.every((m) => (MEMBERS as string[]).includes(m)) && threadFor(ms as Member[]) === id) return ms as Member[];
  }
  return null;
}

/** The thread for a set of members (the two parents alone are the family chat). */
export function threadFor(members: Member[]): string {
  const ms = MEMBERS.filter((m) => members.includes(m));
  if (ms.length === 1) return `task-private-${ms[0]}`;
  if (ms.length === 2 && ms.every((m) => PARENT_IDS.includes(m))) return MAIN_THREAD;
  return `task-with-${ms.join("-")}`;
}

/** Every chat a member is in: their own, then the shared ones (smallest first). */
export function threadsFor(me: Member): string[] {
  const others = MEMBERS.filter((m) => m !== me);
  const out = [threadFor([me])];
  for (const o of others) out.push(threadFor([me, o]));
  if (others.length >= 2) out.push(threadFor(MEMBERS));
  return out;
}

/** What a member calls a thread: "🔒 Just me", or the other people in it ("Sam", "Sam & Grandma"). */
export function threadLabel(id: string, me: Member): string {
  const ms = threadMembers(id) || [];
  if (ms.length === 1) return "🔒 Just me";
  const names = ms.filter((m) => m !== me).map(personName);
  return names.length <= 2 ? names.join(" & ") : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/** "You, Sam, and Grandma" — who's in a thread, from one member's point of view. */
export function threadPeople(id: string, me: Member): string {
  const ms = threadMembers(id) || [];
  const names = ["You", ...ms.filter((m) => m !== me).map(personName)];
  return names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
