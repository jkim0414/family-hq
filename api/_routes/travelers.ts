import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { addAudit } from "../_lib/db.js";
import { vaultConfigured } from "../_lib/vault.js";
import { listTravelers, saveTraveler, travelersFor } from "../_lib/travelers.js";
import { personName } from "../../src/data/people.js";

// GET  /api/travelers                    → { travelers: Traveler[], vault } — a parent: everyone's; a caregiver: her own
// POST /api/travelers { id, ...fields }  → save part of a card; ktn / passportNumber are write-only
//                                          (stored encrypted, shown back as their last four; null clears)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  res.setHeader("cache-control", "no-store");
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const id = String(body?.id || "");
      if (!travelersFor(user.id).includes(id)) return json(res, 403, { error: "not yours to edit" });
      const { id: _id, ...patch } = body;
      const t = await saveTraveler(user.id, id, patch).catch((e) => e as Error);
      if (t instanceof Error) return json(res, 400, { error: t.message });
      // Never the numbers themselves — just what changed.
      const what = [patch.passportNumber !== undefined && "passport", patch.ktn !== undefined && "Known Traveler number", patch.loyalty && "loyalty numbers"].filter(Boolean);
      await addAudit({ kind: "travel", summary: `${user.name} updated ${personName(id)}'s travel card${what.length ? ` (${what.join(", ")})` : ""}`, by: user.id });
      return json(res, 200, { ok: true, traveler: t });
    }
    json(res, 200, { travelers: await listTravelers(user.id), vault: vaultConfigured() });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
