import type { CalEvent, Invite, Todo } from "../../src/data/types";
import type { Classification } from "./classify.js";
import { getCollection, setCollection, appendItems } from "./db.js";
import { createCalendarEvent } from "./calendar.js";
import { onSharedCalendar } from "./privacy.js";
import { adjustPrepDue } from "./util.js";

// ─────────────────────────────────────────────────────────────────────────────
// Invitations: decide first. Something the family is invited to (a party, a district meeting)
// is filed as a pending decision, not put on the calendar. Its prep to-dos wait on it. The
// parents are asked by text (right away when it's soon, else in the morning roundup). A yes
// puts it on the calendar, creates the prep, and Kimi offers to RSVP; a no archives it.
// ─────────────────────────────────────────────────────────────────────────────

type ClassEvent = Classification["events"][number];
type ClassTodo = Classification["todos"][number];

/** The decision state a newly filed event starts with (none: a fixed date). */
export function inviteOf(e: ClassEvent): Invite | undefined {
  if (!e.invitation) return undefined;
  const rsvp = { ...(e.rsvpBy && /^\d{4}-\d{2}-\d{2}$/.test(e.rsvpBy) ? { rsvpBy: e.rsvpBy } : {}), ...(e.rsvp ? { rsvp: e.rsvp.slice(0, 300) } : {}) };
  // The household said they skip this kind of thing: archived quietly, never asked.
  if (e.skip) return { status: "no", decidedBy: "facts", decidedAt: new Date().toISOString(), ...rsvp };
  return { status: "pending", ...rsvp };
}

// To-dos that ask the parents to decide or RSVP: for an invitation, Kimi asks them instead.
const ASK_TODO_RE = /\b(rsvp|decide|whether to (go|attend)|consider (going|attending)|sign up to attend|let .* know if)\b/i;

/**
 * Where a filed to-do goes: as usual, held on its invitation until a yes (prep), or dropped (a
 * "decide/RSVP" to-do for an invitation, or prep for one the family declined).
 */
export function routeTodo(t: ClassTodo, eventFor: (i: number) => CalEvent | undefined, invitationsHere: boolean, placed: (CalEvent | undefined)[] = []): "create" | "drop" | CalEvent {
  // Which event it's prep for: as the model said, or — when it didn't say — the message's only
  // invitation, or the invitation whose title shares a name with it ("Buy a gift for Maya" → Maya's party).
  const target = typeof t.forEvent === "number" ? eventFor(t.forEvent) : invitationsHere ? guessEvent(t.title, placed) : undefined;
  // "RSVP / decide" to-dos for an invitation are never made: the parents are asked directly.
  if (invitationsHere && ASK_TODO_RE.test(t.title)) return "drop";
  if (target?.invite) {
    if (target.invite.status === "pending") return target;
    if (target.invite.status !== "yes") return "drop";
  }
  return "create";
}

const NAME_RE = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)?/g;
const STOP_NAMES = new Set(["Buy", "Get", "Pack", "Wrap", "Write", "Make", "Order", "Bring", "Pick", "Costumes", "Gift", "Card", "Party", "Birthday", "The", "For", "RSVP"]);
function guessEvent(title: string, placed: (CalEvent | undefined)[]): CalEvent | undefined {
  const invites = placed.filter((e): e is CalEvent => !!e?.invite);
  if (invites.length === 1) return invites[0];
  const names = (title.match(NAME_RE) || []).flatMap((n) => n.split(" ")).filter((n) => !STOP_NAMES.has(n));
  return invites.find((e) => names.some((n) => new RegExp(`\\b${n}\\b`).test(e.title)));
}

/** Keep a prep to-do on its invitation until a yes. */
export function holdTodo(evt: CalEvent, t: { title: string; detail?: string; due?: string; priority: "normal" | "high"; owner?: string[]; people?: string[] }): void {
  if (!evt.invite) return;
  const held = evt.invite.heldTodos || [];
  if (!held.some((h) => h.title.toLowerCase() === t.title.toLowerCase())) held.push({ title: t.title, detail: t.detail, due: t.due, priority: t.priority, owner: t.owner, people: t.people });
  evt.invite.heldTodos = held;
}

/**
 * A new candidate matched an event already filed. An invitation matching a fixed event (already
 * on the calendar, so decided) stays fixed; a pending one picks up an RSVP deadline or link it lacked.
 */
export function mergeInvite(existing: CalEvent, candidate: CalEvent): void {
  if (!existing.invite || !candidate.invite) return;
  if (!existing.invite.rsvpBy && candidate.invite.rsvpBy) existing.invite.rsvpBy = candidate.invite.rsvpBy;
  if (!existing.invite.rsvp && candidate.invite.rsvp) existing.invite.rsvp = candidate.invite.rsvp;
}

/**
 * A parent decided (in chat, by text, or with the app's buttons). Yes: the event goes on the
 * calendar (silently: they decided together) and its held prep becomes to-dos. No: archived.
 * Returns what changed, for the reply.
 */
export async function decideInvitations(ids: string[], going: boolean, by: string, opts: { who?: string[]; visible?: (e: CalEvent) => boolean } = {}): Promise<{ events: CalEvent[]; todos: Todo[] }> {
  const events = await getCollection("events");
  const picked = events.filter((e) => ids.includes(e.id) && e.invite && (!opts.visible || opts.visible(e)));
  const made: Todo[] = [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  for (const e of picked) {
    e.invite = { ...e.invite!, status: going ? "yes" : "no", decidedBy: by, decidedAt: new Date().toISOString(), ...(going && opts.who?.length ? { going: opts.who } : {}) };
    if (!going) continue;
    (e.invite.heldTodos || []).forEach((h, i) => {
      // Prep for a party in two days can't be due last week: no earlier than today.
      made.push(adjustPrepDue({ id: `todo-${e.id}-h${i}`, title: h.title, detail: h.detail, due: h.due && h.due < today ? today : h.due, priority: h.priority, owner: h.owner?.length ? h.owner : ["alex", "sam"], people: h.people?.length ? h.people : e.people, done: false, source: e.source, commId: e.commId, ...(e.privateTo ? { privateTo: e.privateTo } : {}), ...(e.audience ? { audience: e.audience } : {}) }, [e.date]));
    });
    e.invite.heldTodos = undefined;
    if (onSharedCalendar(e)) {
      try {
        const gcalId = await createCalendarEvent(e, { silent: true });
        if (gcalId) e.gcalId = gcalId;
      } catch (err) {
        console.error("calendar add after yes failed", err);
      }
    }
  }
  if (picked.length) await setCollection("events", events);
  if (made.length) await appendItems("todos", made);
  return { events: picked, todos: made };
}

/** Invitations whose date has passed without a decision: they quietly drop off. */
export async function expireInvitations(today: string): Promise<number> {
  const events = await getCollection("events");
  const stale = events.filter((e) => e.invite?.status === "pending" && (e.endDate || e.date) < today);
  for (const e of stale) e.invite = { ...e.invite!, status: "expired" };
  if (stale.length) await setCollection("events", events);
  return stale.length;
}
