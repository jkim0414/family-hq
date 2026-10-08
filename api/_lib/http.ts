import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time string compare (hashing first makes the lengths equal). */
export function sameSecret(a: unknown, b: string): boolean {
  if (typeof a !== "string" || !a || !b) return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/**
 * Guard cron/admin endpoints with a shared secret, sent only as `Authorization: Bearer <secret>`
 * (Vercel Cron and the cron-job.org heartbeat both do). Never in the URL: URLs land in logs.
 */
export function authorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false;
  return sameSecret((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), secret);
}

export function json(res: VercelResponse, status: number, body: unknown) {
  res.status(status).setHeader("content-type", "application/json");
  res.send(JSON.stringify(body));
}

/** HTML-escape text that goes into a page or an email (titles and notes come from outside mail). */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
