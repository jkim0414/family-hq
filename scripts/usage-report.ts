#!/usr/bin/env tsx
// Token usage by day, source, and model (logged by api/_lib/usage.ts).
//   npx tsx scripts/usage-report.ts [days=7]
// "cache %" is the share of input served from cache (billed at a fraction of normal input).
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const db = await import("../api/_lib/db");
const days = Number(process.argv[2]) || 7;
const totals = new Map<string, Record<string, number>>();
for (let i = days - 1; i >= 0; i--) {
  const d = new Date(Date.now() - i * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const h = ((await db.redis.hgetall<Record<string, number>>(`usage:${d}`)) || {}) as Record<string, number>;
  for (const [f, v] of Object.entries(h)) {
    const [site, model, kind] = f.split("|");
    const k = `${site}|${model}`;
    const t = totals.get(k) || {};
    t[kind] = (t[kind] || 0) + Number(v);
    totals.set(k, t);
  }
}
if (!totals.size) {
  console.log(`No usage logged in the last ${days} days (logging started with the efficiency audit).`);
  process.exit(0);
}
const k = (n = 0) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
console.log(`Last ${days} days`);
console.log("source        model                calls   input  cache-wr  cache-rd  cache%   output  web");
for (const [key, t] of [...totals.entries()].sort((a, b) => (b[1].out || 0) * 5 + (b[1].in || 0) - ((a[1].out || 0) * 5 + (a[1].in || 0)))) {
  const [site, model] = key.split("|");
  const allIn = (t.in || 0) + (t.cache_write || 0) + (t.cache_read || 0);
  console.log(
    `${site.padEnd(13)} ${model.padEnd(20)} ${String(t.calls || 0).padStart(5)} ${k(t.in).padStart(7)} ${k(t.cache_write).padStart(9)} ${k(t.cache_read).padStart(9)} ${(allIn ? Math.round(((t.cache_read || 0) / allIn) * 100) : 0).toString().padStart(5)}% ${k(t.out).padStart(8)} ${String(t.web_search || 0).padStart(4)}`
  );
}
process.exit(0);
