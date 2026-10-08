import { randomBytes } from "node:crypto";
import { redis } from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// A long text often arrives as several texts a second apart (the phone splits it, or someone
// sends three quick lines). Each webhook parks its piece here and waits a moment; only the last
// piece to arrive goes on, carrying them all — so Kimi answers the whole thing once, instead of
// replying to the first fragment ("your message cut off").
// ─────────────────────────────────────────────────────────────────────────────

const WAIT_MS = 3500;

/** The whole message (pieces in order) for the last piece to arrive; null for earlier pieces. */
export async function coalesce(key: string, text: string, waitMs = WAIT_MS): Promise<string | null> {
  const id = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const list = `coalesce:${key}`;
  await redis.rpush(list, JSON.stringify({ id, text, at: Date.now() }));
  await redis.expire(list, 60);
  await redis.set(`${list}:last`, id, { ex: 60 });
  await new Promise((r) => setTimeout(r, waitMs));
  if ((await redis.get<string>(`${list}:last`)) !== id) return null; // a later piece carries this one
  const raw = ((await redis.lrange(list, 0, -1)) || []) as unknown[];
  await redis.del(list);
  const pieces = raw
    .map((x) => (typeof x === "string" ? (JSON.parse(x) as { text: string; at: number }) : (x as { text: string; at: number })))
    .filter((p) => Date.now() - p.at < 30_000)
    .map((p) => p.text);
  return pieces.length ? pieces.join("\n") : text;
}
