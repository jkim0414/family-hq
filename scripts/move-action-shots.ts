#!/usr/bin/env tsx
// One-time: move approval screenshots out of the actions list into their own keys
// (action_shot:<id>), so every app load stops reading ~150 KB per approval.  --save to write.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const db = await import("../api/_lib/db");
const actions = await db.getCollection("actions");
const before = JSON.stringify(actions).length;
let moved = 0;
for (const a of actions) {
  const p = a.payload as { screenshot?: string; hasScreenshot?: boolean };
  if (!p?.screenshot) continue;
  if (process.argv.includes("--save")) await db.redis.set(`action_shot:${a.id}`, p.screenshot, { ex: 60 * 86400 });
  delete p.screenshot;
  p.hasScreenshot = true;
  moved++;
}
console.log(`${moved} screenshots; actions ${before} → ${JSON.stringify(actions).length} chars`);
if (process.argv.includes("--save")) await db.setCollection("actions", actions);
else console.log("(dry run — pass --save)");
process.exit(0);
