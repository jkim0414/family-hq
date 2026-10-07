import { redis } from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Token usage per day, by where the call came from and which model: input, cache writes, cache
// reads, and output. One HINCRBY batch per call, fire-and-forget (never blocks or fails a reply).
// Read it with `npx tsx scripts/usage-report.ts`.
// ─────────────────────────────────────────────────────────────────────────────

export type UsageSite = "chat" | "browser" | "classify" | "classify_pdf" | "verify" | "receipts" | "triage" | "guard";

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
}

const dayPT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

export function recordUsage(site: UsageSite, model: string, u: UsageLike | null | undefined): void {
  if (!u) return;
  const k = `${site}|${model}`;
  const fields: [string, number][] = [
    [`${k}|calls`, 1],
    [`${k}|in`, u.input_tokens || 0],
    [`${k}|cache_write`, u.cache_creation_input_tokens || 0],
    [`${k}|cache_read`, u.cache_read_input_tokens || 0],
    [`${k}|out`, u.output_tokens || 0],
    [`${k}|web_search`, u.server_tool_use?.web_search_requests || 0],
  ];
  const key = `usage:${dayPT()}`;
  const p = redis.pipeline();
  for (const [f, n] of fields) if (n) p.hincrby(key, f, n);
  p.expire(key, 120 * 86400);
  p.exec().catch(() => {});
}
