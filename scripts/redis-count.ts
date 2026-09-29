#!/usr/bin/env tsx
// Count the Redis commands one ingest tick (the per-minute cron) sends.
// Usage: npx tsx scripts/redis-count.ts [--calsync]  — runs a REAL tick (or calendar mirror), same as the cron would.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const counts: Record<string, number> = {};
// Every Upstash command is an HTTP request; count them at the network layer.
const KV = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").replace(/\/$/, "");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url || input);
  if (KV && url.startsWith(KV)) {
    let cmds: unknown[][] = [];
    try {
      const body = JSON.parse(String(init?.body ?? "[]"));
      cmds = url.includes("/pipeline") || url.includes("/multi-exec") ? body : [body];
    } catch { /* path-style command */ cmds = [[url.slice(KV.length).split("/")[1] || "?"]]; }
    for (const c of cmds) {
      const key = `${String(c[0]).toLowerCase()} ${typeof c[1] === "string" ? String(c[1]).replace(/:[^:]*$/, ":*") : ""}`.trim();
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return realFetch(input, init);
}) as typeof fetch;
const { default: ingest } = await import("../api/_routes/ingest");
if (process.argv.includes("--calsync")) {
  const { importCalendarEvents } = await import("../api/_lib/calsync");
  const r = await importCalendarEvents();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ calsync: true, total, counts, result: r }, null, 1));
  process.exit(0);
}
const req: any = { method: "GET", query: { secret: process.env.CRON_SECRET }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } };
let body: any;
const res: any = { statusCode: 200, setHeader() {}, status(c: number) { this.statusCode = c; return this; }, json(b: any) { body = b; return this; }, send(b: any) { body = b; return this; }, end() { return this; } };
await ingest(req, res);
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ total, counts, result: typeof body === "object" ? { ok: body?.ok, busy: body?.busy, watchRan: body?.watch?.ran, tasksRan: body?.tasksRan } : body }, null, 1));
process.exit(0);
