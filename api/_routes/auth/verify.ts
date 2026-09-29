import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../../_lib/http.js";
import { consumeLoginToken, consumeLoginCode, createSession, setSessionCookie } from "../../_lib/auth.js";

// GET  /api/auth/verify?token=…      → a page with a "Log in" button (prefetch-proof:
//                                      link scanners GET; only the POST consumes)
// POST /api/auth/verify  form {token} | JSON {email, code}  → sets the device session
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      res.setHeader("location", "/?login=invalid");
      return res.status(302).end();
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Log in — Family HQ</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;max-width:360px;width:90%}h1{font-size:20px;margin:0 0 6px}p{color:#64748b;font-size:14px;margin:0 0 16px}button{width:100%;background:#2563eb;color:#fff;border:0;border-radius:12px;padding:12px;font-size:15px;font-weight:600}</style></head>
<body><main><h1>🏡 Family HQ</h1><p>Log in to this browser. (If you use the home-screen app, enter the 6-digit code from the email there instead.)</p>
<form method="POST" action="/api/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><button type="submit">Log in</button></form></main></body></html>`);
  }

  if (req.method !== "POST") return json(res, 405, { error: "GET or POST" });
  const isJson = String(req.headers["content-type"] || "").includes("application/json");
  try {
    const body: any = typeof req.body === "string" ? (isJson ? JSON.parse(req.body) : Object.fromEntries(new URLSearchParams(req.body))) : req.body || {};
    let user = null;
    if (body.token) user = await consumeLoginToken(String(body.token));
    else if (body.email && body.code) user = await consumeLoginCode(String(body.email), String(body.code).trim());

    if (!user) {
      if (isJson) return json(res, 401, { error: "That code is invalid or expired — request a new one." });
      res.setHeader("location", "/?login=invalid");
      return res.status(302).end();
    }
    const id = await createSession(user);
    setSessionCookie(res, id);
    if (isJson) return json(res, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email } });
    res.setHeader("location", "/");
    res.status(302).end();
  } catch (err) {
    if (isJson) return json(res, 500, { error: String(err) });
    res.setHeader("location", "/?login=invalid");
    res.status(302).end();
  }
}
