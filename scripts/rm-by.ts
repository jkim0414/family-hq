#!/usr/bin/env tsx
// Remove comms (and their linked todos/events) whose summary/raw matches a regex.
// Usage: npx tsx scripts/rm-by.ts "newsletter|promo"
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const pattern = process.argv[2];
const confirm = process.argv.includes("--yes");
// By default match only subject + summary. The raw email body is noisy (a sender's
// boilerplate footer can match unrelated messages), so searching it is opt-in via --raw.
const includeRaw = process.argv.includes("--raw");
if (!pattern) { console.error("usage: rm-by.ts <regex> [--yes] [--raw]"); process.exit(1); }
const re = new RegExp(pattern, "i");
const { redis } = await import("../api/_lib/db");

const comms = (await redis.get<any[]>("comms")) || [];
const hit = comms.filter((c) =>
  re.test(`${c.summary || ""} ${c.subject || ""}${includeRaw ? " " + (c.raw || "") : ""}`)
);

// Safety: show exactly what matches and require --yes to delete (avoids
// over-broad patterns silently nuking real data).
console.log(`matched ${hit.length} comms for /${pattern}/i:`);
for (const c of hit) console.log("  -", c.subject, "|", (c.summary || "").slice(0, 60));
if (!confirm) { console.log("\nDRY RUN — re-run with --yes to delete."); process.exit(0); }

const todoIds = new Set(hit.flatMap((c) => c.todoIds || []));
const eventIds = new Set(hit.flatMap((c) => c.eventIds || []));
const commIds = new Set(hit.map((c) => c.id));
await redis.set("comms", comms.filter((c) => !commIds.has(c.id)));
await redis.set("todos", ((await redis.get<any[]>("todos")) || []).filter((t) => !todoIds.has(t.id)));
await redis.set("events", ((await redis.get<any[]>("events")) || []).filter((e) => !eventIds.has(e.id)));
console.log(`removed ${hit.length} comms, ${todoIds.size} todos, ${eventIds.size} events.`);
