import type { VercelRequest, VercelResponse } from "@vercel/node";
import { google } from "googleapis";
import { redis } from "../../_lib/db.js";
import { requireParent, sessionIdOf } from "../../_lib/auth.js";
import { setCalendarToken } from "../../_lib/calendar.js";
import { saveGmailConn } from "../../_lib/gmail.js";
import { REDIRECT_URI } from "./start.js";

// GET /api/oauth/callback?code=…&state=<one-time nonce from /api/oauth/start>
// A parent connecting their Gmail (read-only) or the family calendar.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = req.query.code as string | undefined;
  const state = (req.query.state as string | undefined) || "";
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);

  const pending = /^[A-Za-z0-9_-]{20,40}$/.test(state)
    ? await redis.getdel<{ kind: string; userId: string; session?: string; returnTo: string }>(`oauth_state:${state}`)
    : null;
  if (!pending) return res.status(401).send("This sign-in link expired. Start again from the app.");
  // The browser that finishes the flow must be the one that started it (a copied consent link
  // can't attach someone else's Google account).
  const user = await requireParent(req);
  if (!user || user.id !== pending.userId || (pending.session && pending.session !== sessionIdOf(req))) {
    return res.status(401).send("Finish connecting in the same browser you started from, signed in to the app.");
  }
  const back = (q: string) => {
    res.writeHead(302, { Location: `${pending.returnTo}?${pending.kind}=${q}#settings` });
    res.end();
  };
  if (!code) return back("denied");
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) return back("noref");
    oauth2.setCredentials(tokens);
    const me = await google.oauth2({ version: "v2", auth: oauth2 }).userinfo.get().catch(() => null);
    if (pending.kind === "calendar") {
      await setCalendarToken(tokens.refresh_token);
      return back("connected");
    }
    await saveGmailConn(pending.userId, { refreshToken: tokens.refresh_token, email: me?.data.email || "", connectedAt: new Date().toISOString() });
    return back("connected");
  } catch (err) {
    console.error("oauth failed", (err as Error)?.message);
    return back("error");
  }
}
