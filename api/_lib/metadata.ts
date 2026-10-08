import { getCollection, setCollection, redis, appendItems } from "./db.js";
import type { MetadataOp, Kid, Contact, Routine, Suggestion } from "../../src/data/types";

function genId(p: string) {
  return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface Ctx {
  kids: Kid[];
  contacts: Contact[];
  routines: Routine[];
}

// Apply a single metadata op to in-memory collections. Returns changed collection names.
export function applyOp(op: MetadataOp, ctx: Ctx): string[] {
  const changed: string[] = [];
  if (op.kind === "set_teacher") {
    const k = ctx.kids.find((x) => x.id === op.kidId);
    if (k) {
      k[op.term].teachers = op.teachers;
      changed.push("kids");
    }
  } else if (op.kind === "set_school") {
    const k = ctx.kids.find((x) => x.id === op.kidId);
    if (k) {
      k[op.term].school = op.school;
      changed.push("kids");
    }
  } else if (op.kind === "set_contact") {
    let c = ctx.contacts.find((x) => x.name.toLowerCase() === op.name.toLowerCase());
    if (!c) {
      c = { id: genId("contact"), name: op.name, role: op.role || "", kidIds: (op.kidIds as any) || [] };
      ctx.contacts.push(c);
    }
    if (op.role) c.role = op.role;
    if (op.email) c.email = op.email;
    if (op.phone) c.phone = op.phone;
    if (op.kidIds?.length) c.kidIds = Array.from(new Set([...(c.kidIds || []), ...op.kidIds])) as any;
    changed.push("contacts");
  } else if (op.kind === "set_routine") {
    let r = ctx.routines.find((x) => x.kidId === op.kidId && x.label.toLowerCase() === op.label.toLowerCase());
    if (!r) {
      r = { id: genId("r"), kidId: op.kidId as any, label: op.label, detail: op.detail };
      ctx.routines.push(r);
    } else {
      r.detail = op.detail;
    }
    changed.push("routines");
  } else if (op.kind === "promote_kid") {
    const k = ctx.kids.find((x) => x.id === op.kidId);
    if (k) {
      k.current = { ...k.fall }; // fall becomes the current year
      k.fall = { school: k.current.school, program: "TBD", teachers: ["TBD"], aftercare: k.current.aftercare };
      changed.push("kids");
    }
  }
  return changed;
}

// Build a validated MetadataOp from a (flattened) classifier metadata change.
export function toOp(m: any): MetadataOp | null {
  switch (m?.kind) {
    case "set_teacher":
      return m.kidId && m.term && m.teachers?.length
        ? { kind: "set_teacher", kidId: m.kidId, term: m.term, teachers: m.teachers }
        : null;
    case "set_school":
      return m.kidId && m.term && m.school ? { kind: "set_school", kidId: m.kidId, term: m.term, school: m.school } : null;
    case "set_contact":
      return m.name ? { kind: "set_contact", name: m.name, role: m.role, kidIds: m.kidIds, email: m.email, phone: m.phone } : null;
    case "set_routine":
      return m.kidId && m.label && m.detail ? { kind: "set_routine", kidId: m.kidId, label: m.label, detail: m.detail } : null;
    default:
      return null;
  }
}

/** Apply confident metadata changes; queue the rest as suggestions. */
export async function applyMetadata(
  changes: any[] | undefined,
  commId: string,
  now: string,
  /** May these apply on their own? (Otherwise every change waits for a parent.) */
  trusted = true
): Promise<{ applied: number; suggested: number }> {
  if (!changes?.length) return { applied: 0, suggested: 0 };
  const [kids, contacts, routines, suggestions] = await Promise.all([
    getCollection("kids"),
    getCollection("contacts"),
    getCollection("routines"),
    getCollection("suggestions"),
  ]);
  const ctx: Ctx = { kids, contacts, routines };
  const changedCollections = new Set<string>();
  let applied = 0;
  const newSuggestions: Suggestion[] = [];

  for (const m of changes) {
    const op = toOp(m);
    if (!op) continue;
    if (m.confident && trusted) {
      applyOp(op, ctx).forEach((c) => changedCollections.add(c));
      applied++;
    } else {
      newSuggestions.push({ id: genId("sug"), description: m.description || "Update metadata", op, createdAt: now, commId });
    }
  }

  if (changedCollections.has("kids")) await setCollection("kids", kids);
  if (changedCollections.has("contacts")) await setCollection("contacts", contacts);
  if (changedCollections.has("routines")) await setCollection("routines", routines);
  if (newSuggestions.length) await appendItems("suggestions", newSuggestions);

  return { applied, suggested: newSuggestions.length };
}

/**
 * Time-triggered (not email-triggered): once the school year has started — derived
 * from the "First Day of School" calendar event — propose promoting each kid whose
 * fall differs from current (current ← fall) and refreshing drop-off/pickup.
 * Idempotent (deterministic suggestion id) and gated by notBefore = the start date.
 */
export async function ensureSeasonalSuggestions(now: string): Promise<number> {
  const today = now.slice(0, 10);
  const [events, kids, suggestions] = await Promise.all([
    getCollection("events"),
    getCollection("kids"),
    getCollection("suggestions"),
  ]);

  // The most recent "First Day of School" that has already occurred.
  const started = events
    .filter((e) => /first day of school/i.test(e.title) && e.date <= today)
    .map((e) => e.date)
    .sort();
  const startDate = started[started.length - 1];
  if (!startDate) return 0; // new year hasn't started yet

  const additions: Suggestion[] = [];
  for (const k of kids) {
    // A meaningful promotion needs a real fall assignment. After a promotion,
    // fall describes NEXT year (often "TBD") — that must not re-trigger.
    if (!k.fall || k.fall.program === "TBD") continue;
    const changed =
      k.fall.program !== k.current.program ||
      JSON.stringify(k.fall.teachers) !== JSON.stringify(k.current.teachers) ||
      k.fall.school !== k.current.school;
    if (!changed) continue;
    const id = `sug-promote-${k.id}-${startDate}`;
    if (suggestions.some((s) => s.id === id)) continue;
    // Once applied OR dismissed, a suggestion id is handled forever — the
    // deterministic id makes this proposal once-per-kid-per-school-year.
    if (await redis.sismember("handled_suggestions", id)) continue;
    additions.push({
      id,
      description: `New school year — promote ${k.firstName} to ${k.fall.program} (${k.fall.teachers.join(", ")})${k.fall.school !== k.current.school ? ` @ ${k.fall.school}` : ""}, then refresh drop-off/pickup.`,
      op: { kind: "promote_kid", kidId: k.id },
      createdAt: now,
      notBefore: startDate,
    });
  }
  if (additions.length) await appendItems("suggestions", additions);
  return additions.length;
}
