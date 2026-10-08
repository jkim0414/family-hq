import type { VercelRequest, VercelResponse } from "@vercel/node";
import { google } from "googleapis";
import { randomBytes } from "node:crypto";
import { requireParent, requestOrigin, sessionIdOf } from "../../_lib/auth.js";
import { redis } from "../../_lib/db.js";
import { GMAIL_SCOPES } from "../../_lib/gmail.js";

// The registered redirect URI (Google Cloud console): <APP_URL>/api/oauth/callback when APP_URL
// is set, else this deployment's original hostname. The app is served from two hostnames; the
// callback identifies the user by the one-time state nonce, not by cookie, so it works
// regardless of which host started the flow.
export const REDIRECT_URI = `${process.env.APP_URL || "https://your-app.vercel.app"}/api/oauth/callback`;

// GET /api/oauth/start?for=calendar  → Google consent for the family CALENDAR (a signed-in parent)
// GET /api/oauth/start?for=gmail     → Google consent for the signed-in parent's Gmail (read-only)
// Both use a one-time state nonce bound to the session that started the flow.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).send("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const user = await requireParent(req);
  if (!user) {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }
  const kind = req.query.for === "calendar" ? "calendar" : "gmail";
  const nonce = randomBytes(18).toString("base64url");
  await redis.set(`oauth_state:${nonce}`, { kind, userId: user.id, session: sessionIdOf(req), returnTo: `${requestOrigin(req)}/assistant` }, { ex: 600 });
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always mint a refresh token
    scope: kind === "calendar" ? ["https://www.googleapis.com/auth/calendar.events"] : GMAIL_SCOPES,
    login_hint: user.email,
    state: nonce,
  });
  res.writeHead(302, { Location: url });
  res.end();
}
