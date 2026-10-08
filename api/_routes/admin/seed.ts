import type { VercelRequest, VercelResponse } from "@vercel/node";
import { replaceCollection } from "../../_lib/db.js";
import { authorized, json } from "../../_lib/http.js";
import { KIDS } from "../../../src/data/kids.js";
import { PLACES, CONTACTS, ROUTINES } from "../../../src/data/meta.js";
import { COMMS } from "../../../src/data/comms.js";
import { EVENTS } from "../../../src/data/events.js";
import { TODOS } from "../../../src/data/todos.js";

// POST /api/admin/seed (Bearer CRON_SECRET)        → seed meta (kids/places/contacts/routines),
//                                           start comms/events/todos EMPTY (go-live).
// POST /api/admin/seed?demo=1 (Bearer CRON_SECRET) → also load the illustrative demo items.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Wipes collections: POST only (a GET can be replayed from a log or a link preview).
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!authorized(req)) return json(res, 401, { error: "unauthorized — send the secret as a Bearer header" });
  const withDemo = req.query.demo === "1";
  try {
    await replaceCollection("kids", KIDS);
    await replaceCollection("places", PLACES);
    await replaceCollection("contacts", CONTACTS);
    await replaceCollection("routines", ROUTINES);
    await replaceCollection("comms", withDemo ? COMMS : []);
    await replaceCollection("events", withDemo ? EVENTS : []);
    await replaceCollection("todos", withDemo ? TODOS : []);
    await replaceCollection("suggestions", []);
    json(res, 200, { ok: true, demo: withDemo });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
