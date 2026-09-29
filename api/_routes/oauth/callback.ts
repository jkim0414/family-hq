import type { VercelRequest, VercelResponse } from "@vercel/node";
import { google } from "googleapis";
import { redis } from "../../_lib/db.js";
import { saveGmailConn } from "../../_lib/gmail.js";
import { REDIRECT_URI } from "./start.js";

// GET /api/oauth/callback?code=…&state=…
// - state = a one-time nonce → a parent connecting their Gmail (read-only)
// - state = CRON_SECRET     → the family calendar connection (legacy, one-time)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = req.query.code as string | undefined;
  const state = (req.query.state as string | undefined) || "";
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);

  const pending = state && state !== process.env.CRON_SECRET ? await redis.get<{ kind: string; userId: string; returnTo: string }>(`oauth_state:${state}`) : null;
  if (pending) {
    await redis.del(`oauth_state:${state}`);
    const back = (q: string) => {
      res.writeHead(302, { Location: `${pending.returnTo}?gmail=${q}#settings` });
      res.end();
    };
    if (!code) return back("denied");
    try {
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) return back("noref");
      oauth2.setCredentials(tokens);
      const me = await google.oauth2({ version: "v2", auth: oauth2 }).userinfo.get();
      await saveGmailConn(pending.userId, { refreshToken: tokens.refresh_token, email: me.data.email || "", connectedAt: new Date().toISOString() });
      return back("connected");
    } catch (err) {
      console.error("gmail oauth failed", err);
      return back("error");
    }
  }

  if (state !== process.env.CRON_SECRET) return res.status(401).send("bad state");
  if (!code) return res.status(400).send("missing code");
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(400).send("No refresh token returned. Remove the app's access at myaccount.google.com/permissions and try /api/oauth/start again.");
    }
    await redis.set("google_refresh_token", tokens.refresh_token);
    res.setHeader("content-type", "text/html");
    res.status(200).send(
      `<div style="font-family:system-ui;max-width:480px;margin:60px auto;text-align:center">
        <h2>✅ Google Calendar connected</h2>
        <p>School events will now be added to your Personal calendar automatically, inviting Sam.</p>
        <p><a href="https://your-app.vercel.app">Open the hub →</a></p>
      </div>`
    );
  } catch (err) {
    res.status(500).send("Token exchange failed: " + String(err));
  }
}
