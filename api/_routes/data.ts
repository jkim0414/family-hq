import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getState, getStateVersion, getCollection } from "../_lib/db.js";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { canSee, canSeeArtifact, isParent } from "../_lib/privacy.js";
import type { Member } from "../../src/data/types";

// GET /api/data            → app state for the frontend (signed-in members; trimmed by role)
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
      const c = (await getCollection("comms")).find((x) => x.id === req.query.comm && canSee(x, user.id));
      return json(res, 200, { raw: c?.raw || "" });
    }
    const v = await getStateVersion();
    if (typeof req.query.v === "string" && Number(req.query.v) === v && v > 0) return json(res, 200, { unchanged: true, v });
    const state = await getState();
    // Private items are only ever sent to the member they belong to. The caregiver gets the
    // household calendar, to-dos, kids, facts, and mail, but not spending or the activity log;
    // of approvals and schedules, only her own.
    const parent = isParent(user.id);
    const mine = <T extends { privateTo?: Member; audience?: Member[] }>(xs: T[]) => (xs || []).filter((x) => canSee(x, user.id));
    const ours = <T extends { privateTo?: Member; requester?: Member }>(xs: T[]) => (xs || []).filter((x) => canSeeArtifact(x, user.id));
    const slim = {
      ...state,
      events: mine(state.events),
      todos: mine(state.todos),
      spending: parent ? mine(state.spending) : [],
      schedules: ours(state.schedules),
      audit: parent ? mine(state.audit) : [],
      suggestions: parent ? state.suggestions : [], // calendar/roster changes for a parent to confirm
      v,
      me: { id: user.id, name: user.name, role: user.role },
      comms: mine(state.comms).map(({ raw, ...c }) => ({ ...c, hasRaw: !!raw })),
      profile: { ...state.profile, facts: mine(state.profile.facts) },
      actions: ours(state.actions).map((a) => {
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
