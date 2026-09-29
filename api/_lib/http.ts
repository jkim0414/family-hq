import type { VercelRequest, VercelResponse } from "@vercel/node";

/** Guard cron/admin endpoints with a shared secret (?secret= or Bearer header). */
export function authorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const fromQuery = req.query.secret;
  const fromHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return fromQuery === secret || fromHeader === secret;
}

export function json(res: VercelResponse, status: number, body: unknown) {
  res.status(status).setHeader("content-type", "application/json");
  res.send(JSON.stringify(body));
}
