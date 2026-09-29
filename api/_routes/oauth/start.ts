import type { VercelRequest, VercelResponse } from "@vercel/node";
import { google } from "googleapis";
import { randomBytes } from "node:crypto";
import { authorized } from "../../_lib/http.js";
import { requireUser, requestOrigin } from "../../_lib/auth.js";
import { redis } from "../../_lib/db.js";
import { GMAIL_SCOPES } from "../../_lib/gmail.js";

// The registered redirect URI (Google Cloud console). The app is served from two
// hostnames; the callback identifies the user by the one-time state nonce, not
// by cookie, so it works regardless of which host started the flow.
export const REDIRECT_URI = "https://your-app.vercel.app/api/oauth/callback";

// GET /api/oauth/start?secret=…      → Google consent for the family CALENDAR (one-time, admin)
// GET /api/oauth/start?for=gmail     → Google consent for the LOGGED-IN parent's Gmail (read-only)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).send("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  if (req.query.for === "gmail") {
    const user = await requireUser(req);
    if (!user) {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    const nonce = randomBytes(18).toString("base64url");
    await redis.set(`oauth_state:${nonce}`, { kind: "gmail", userId: user.id, returnTo: `${requestOrigin(req)}/assistant` }, { ex: 600 });
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // always mint a refresh token
      scope: GMAIL_SCOPES,
      login_hint: user.email,
      state: nonce,
    });
    res.writeHead(302, { Location: url });
    return res.end();
  }

  if (!authorized(req)) return res.status(401).send("unauthorized");
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: process.env.CRON_SECRET, // verified in the callback
  });
  res.writeHead(302, { Location: url });
  res.end();
}
