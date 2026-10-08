import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../../_lib/http.js";
import { createLoginToken, createLoginCode, requestOrigin, loginRequestBlocked } from "../../_lib/auth.js";
import { sendEmail } from "../../_lib/email.js";

// POST /api/auth/request  { email }  — email a 6-digit login code (+ a link).
// Always answers ok (no account enumeration); only allowlisted emails get mail.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const email = String(body?.email || "").trim();
    if (!email) return json(res, 400, { error: "email required" });
    const blocked = await loginRequestBlocked(email);
    if (blocked) return json(res, 429, { error: blocked });

    const [code, token] = await Promise.all([createLoginCode(email), createLoginToken(email)]);
    if (code && token) {
      const link = `${requestOrigin(req)}/api/auth/verify?token=${token}`;
      await sendEmail(
        `${code} is your Family HQ login code`,
        `<div style="font-family:system-ui,sans-serif;max-width:480px">
<h2 style="margin:0 0 8px">🏡 Family HQ</h2>
<p>Enter this code in the app to log in on that device:</p>
<p style="font-size:34px;font-weight:700;letter-spacing:6px;margin:8px 0 16px">${code}</p>
<p style="color:#666;font-size:13px">Using a regular browser instead of the home-screen app? You can also <a href="${link}">log in with this link</a>. Both expire in 15 minutes.</p>
<p style="color:#888;font-size:12px">If you didn't request this, ignore it.</p>
</div>`,
        { to: [email], text: `Your Family HQ login code: ${code}\n\nOr log in with this link: ${link}\n\nBoth expire in 15 minutes.` }
      );
    }
    json(res, 200, { ok: true });
  } catch (err) {
    console.error("login request failed", (err as Error)?.message);
    json(res, 500, { error: "Couldn't send the code. Try again in a minute." });
  }
}
