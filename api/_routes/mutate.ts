import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getCollection, setCollection, type AppState } from "../_lib/db.js";
import { json } from "../_lib/http.js";
import { canSee, PARENTS } from "../_lib/privacy.js";
import { requireUser } from "../_lib/auth.js";
import { updateCalendarEvent, deleteCalendarEvent } from "../_lib/calendar.js";
import type { CalEvent } from "../../src/data/types";

const EDITABLE: (keyof AppState)[] = [
  "events",
  "todos",
  "kids",
  "contacts",
  "places",
  "routines",
];

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// POST /api/mutate  { op: "upsert"|"delete", collection, item?, id? }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { op, collection } = body || {};
    if (!EDITABLE.includes(collection)) return json(res, 400, { error: "bad collection" });
    // The caregiver can edit the calendar and to-dos; the kids, contacts, places and routines are the parents'.
    if (user.role !== "parent" && collection !== "events" && collection !== "todos") return json(res, 403, { error: "only a parent can edit that" });

    const list = (await getCollection(collection)) as any[];
    // A member can only touch items they can see (shared ones, their own private ones, and their chats').
    const mine = (x: any) => canSee(x || {}, user.id);

    if (op === "delete") {
      const id = body.id;
      const target = list.find((x) => x.id === id);
      if (target && !mine(target)) return json(res, 404, { error: "not found" });
      if (collection === "events" && target?.gcalId) {
        await deleteCalendarEvent(target.gcalId).catch(() => {});
      }
      await setCollection(collection, list.filter((x) => x.id !== id) as any);
      return json(res, 200, { ok: true });
    }

    if (op === "upsert") {
      const item = { ...body.item };
      if (!item.id) item.id = genId(collection.slice(0, 4));
      const prior = list.find((x) => x.id === item.id);
      if (prior && !mine(prior)) return json(res, 404, { error: "not found" });
      if (item.privateTo && item.privateTo !== user.id) return json(res, 400, { error: "can only make items private to yourself" });
      if (item.audience && !(Array.isArray(item.audience) && item.audience.includes(user.id))) return json(res, 400, { error: "bad audience" });
      if (prior?.privateTo) item.privateTo = prior.privateTo; // stays private
      if (prior?.audience) item.audience = prior.audience; // stays within its chat

      // Events: sync to Google Calendar and capture the gcal id — never for private events.
      if (collection === "events" && PARENTS.every((p) => canSee(item, p))) {
        try {
          const gcalId = await updateCalendarEvent(item as CalEvent);
          if (gcalId) item.gcalId = gcalId;
        } catch {
          /* non-fatal */
        }
      }

      const idx = list.findIndex((x) => x.id === item.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...item };
      else list.push(item);
      await setCollection(collection, list as any);
      return json(res, 200, { ok: true, item });
    }

    return json(res, 400, { error: "bad op" });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
}
