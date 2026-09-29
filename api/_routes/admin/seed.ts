import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setCollection } from "../../_lib/db.js";
import { authorized, json } from "../../_lib/http.js";
import { KIDS } from "../../../src/data/kids.js";
import { PLACES, CONTACTS, ROUTINES } from "../../../src/data/meta.js";
import { COMMS } from "../../../src/data/comms.js";
import { EVENTS } from "../../../src/data/events.js";
import { TODOS } from "../../../src/data/todos.js";

// POST /api/admin/seed?secret=...        → seed meta (kids/places/contacts/routines),
//                                           start comms/events/todos EMPTY (go-live).
// POST /api/admin/seed?secret=...&demo=1 → also load the illustrative demo items.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
  const withDemo = req.query.demo === "1";
  try {
    await setCollection("kids", KIDS);
    await setCollection("places", PLACES);
    await setCollection("contacts", CONTACTS);
    await setCollection("routines", ROUTINES);
    await setCollection("comms", withDemo ? COMMS : []);
    await setCollection("events", withDemo ? EVENTS : []);
    await setCollection("todos", withDemo ? TODOS : []);
    await setCollection("suggestions", []);
    json(res, 200, { ok: true, demo: withDemo });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
