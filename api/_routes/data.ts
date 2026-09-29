import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getState, getStateVersion, getCollection } from "../_lib/db.js";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";

// GET /api/data            → app state for the frontend (logged-in parents only)
// GET /api/data?v=<n>      → { unchanged: true } when nothing was written since version n
// GET /api/data?comm=<id>  → one message's full original text (shown on demand in History)
//
// The state omits the heavy fields nobody reads at a glance — screenshots on
// approval cards and raw email bodies — which are ~90% of its size. Clients
// fetch those individually when a card is expanded.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  res.setHeader("cache-control", "no-store");
  try {
    if (typeof req.query.comm === "string") {
      const c = (await getCollection("comms")).find((x) => x.id === req.query.comm);
      return json(res, 200, { raw: c?.raw || "" });
    }
    const v = await getStateVersion();
    if (typeof req.query.v === "string" && Number(req.query.v) === v && v > 0) return json(res, 200, { unchanged: true, v });
    const state = await getState();
    const slim = {
      ...state,
      v,
      comms: state.comms.map(({ raw, ...c }) => ({ ...c, hasRaw: !!raw })),
      actions: state.actions.map((a) => {
        const p = a.payload as { screenshot?: string };
        if (!p?.screenshot) return a;
        const { screenshot: _s, ...rest } = p;
        return { ...a, payload: { ...rest, hasScreenshot: true } };
      }),
    };
    json(res, 200, slim);
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
