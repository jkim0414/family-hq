import { redis } from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Time-sensitive mail ("permission slip due tomorrow", "early dismissal today") reaches the parents
// by text, not email: filing queues it here, and the 5-minute stage (agent.ts runAlerts) has Kimi
// check each is still open — not already done, not a confirmation, not past — and text what's left.
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingAlert { commId: string; title: string; summary: string; owner: string[]; at: string }
const KEY = "alerts_pending";

export async function queueAlerts(list: PendingAlert[]): Promise<void> {
  if (list.length) await redis.hset(KEY, Object.fromEntries(list.map((a) => [a.commId, a])));
}

export async function pendingAlerts(): Promise<PendingAlert[]> {
  const all = ((await redis.hgetall<Record<string, PendingAlert>>(KEY)) || {}) as Record<string, PendingAlert>;
  return Object.values(all).sort((a, b) => a.at.localeCompare(b.at));
}

export async function clearAlerts(ids: string[]): Promise<void> {
  if (ids.length) await redis.hdel(KEY, ...ids);
}
