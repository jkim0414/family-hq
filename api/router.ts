import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "./_lib/http.js";

// ─────────────────────────────────────────────────────────────────────────────
// Single API function (reached via the vercel.json rewrite /api/:path* →
// /api/router?path=…). Vercel's Hobby plan caps a deployment at 12
// serverless functions; routing every /api/* path through one function keeps
// us clear of that forever. Handlers live in api/_routes (underscore dirs are
// not treated as functions) and keep their original URLs — crons and webhooks
// are unaffected. req.url still carries the original path + query.
// ─────────────────────────────────────────────────────────────────────────────

import data from "./_routes/data.js";
import mutate from "./_routes/mutate.js";
import todo from "./_routes/todo.js";
import capture from "./_routes/capture.js";
import profile from "./_routes/profile.js";
import suggestion from "./_routes/suggestion.js";
import ingest from "./_routes/ingest.js";
import digest from "./_routes/digest.js";
import chat from "./_routes/chat.js";
import tasks from "./_routes/tasks.js";
import sms from "./_routes/sms.js";
import smsGroup from "./_routes/smsgroup.js";
import authRequest from "./_routes/auth/request.js";
import authVerify from "./_routes/auth/verify.js";
import authSession from "./_routes/auth/session.js";
import oauthStart from "./_routes/oauth/start.js";
import oauthCallback from "./_routes/oauth/callback.js";
import adminSeed from "./_routes/admin/seed.js";
import action from "./_routes/action.js";
import files from "./_routes/files.js";
import file from "./_routes/file.js";
import vault from "./_routes/vault.js";
import push from "./_routes/push.js";
import gmail from "./_routes/gmail.js";
import workcal from "./_routes/workcal.js";
import schedules from "./_routes/schedules.js";

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<unknown> | unknown;

const ROUTES: Record<string, Handler> = {
  data,
  mutate,
  todo,
  capture,
  profile,
  suggestion,
  ingest,
  digest,
  chat,
  tasks,
  sms,
  action,
  files,
  file,
  vault,
  push,
  gmail,
  workcal,
  schedules,
  "sms/group": smsGroup,
  "auth/request": authRequest,
  "auth/verify": authVerify,
  "auth/session": authSession,
  "oauth/start": oauthStart,
  "oauth/callback": oauthCallback,
  "admin/seed": adminSeed,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const segs = req.query.path;
  const path = (Array.isArray(segs) ? segs : [segs]).filter(Boolean).join("/");
  const route = ROUTES[path];
  if (!route) return json(res, 404, { error: `no such endpoint: /api/${path}` });
  return route(req, res);
}
