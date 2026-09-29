#!/usr/bin/env tsx
// Print how the work calendars classify this week (meeting vs hold vs commute) and the digest line per day.
// Usage: npx tsx scripts/workcal-peek.ts [days]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { redis } = await import("../api/_lib/db");
const { getWorkBlocks, formatBlocks, summarizeDay, commutesDaily } = await import("../api/_lib/workcal");
const { utcToWall, HOME_TZ } = await import("../src/data/tz");
const keys = await redis.keys("workcal_cache:*");
if (keys.length) await redis.del(...keys);
const days = Number(process.argv[2] || 7);
const from = new Date(); from.setHours(0, 0, 0, 0);
const to = new Date(+from + days * 86400000);
for (const p of ["alex", "sam"] as const) {
  const blocks = await getWorkBlocks(p, from, to);
  console.log(`\n== ${p} (${blocks.length} blocks) ==`);
  console.log(formatBlocks(blocks));
  const dates = [...new Set(blocks.map((b) => (b.allDay ? b.start.slice(0, 10) : utcToWall(new Date(b.start), HOME_TZ).date)))].sort();
  const officeDays = !commutesDaily(blocks);
  console.log(`  commutes daily: ${!officeDays}`);
  for (const d of dates) console.log(`  digest ${d}: ${summarizeDay(blocks, d, { officeDays })}`);
}
process.exit(0);
