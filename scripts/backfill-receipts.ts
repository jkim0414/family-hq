#!/usr/bin/env tsx
// Fill the spending log from receipts already in both parents' inboxes.
// Dry-run by default (prints what it would record); --yes to write. --days N (default 45).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const write = process.argv.includes("--yes");
const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 45;
const { fetchRecent } = await import("../api/_lib/imap");
const receipts = await import("../api/_lib/receipts");
const db = await import("../api/_lib/db");
const QUERY = 'subject:(receipt OR order OR invoice OR payment OR confirmation OR "you paid" OR purchase)';
const existing = await db.getCollection("spending");
const added: any[] = [];
for (const p of ["alex", "sam"] as const) {
  const msgs = await fetchRecent(p, { days, max: 200, query: QUERY, seen: async () => new Set() });
  const cand = msgs.filter(receipts.looksLikeReceipt);
  console.log(`${p}: ${msgs.length} matched the search, ${cand.length} look like receipts`);
  for (let i = 0; i < cand.length; i += 12) {
    const got = await receipts.extractPurchases(p, cand.slice(i, i + 12), [...existing, ...added]);
    added.push(...got);
  }
}
if (write && added.length) await db.setCollection("spending", [...existing, ...added].sort((a, b) => b.date.localeCompare(a.date)));
const rows = [...added].sort((a, b) => b.date.localeCompare(a.date));
console.log(`\n${rows.length} new purchases${write ? " saved" : " (dry run — pass --yes to save)"}:`);
for (const r of rows.slice(0, 100)) console.log(`  ${r.date} ${r.account.padEnd(5)} ${r.merchant.padEnd(24).slice(0, 24)} $${r.amount.toFixed(2).padStart(8)}  ${r.description}${r.byKimi ? "  [Kimi]" : ""}`);
process.exit(0);
