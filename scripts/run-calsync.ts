#!/usr/bin/env tsx
// Manually run the Personal-calendar importer. Dry-run by default (previews what
// would be imported + the EA to-dos it would infer, without writing). --yes commits.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const confirm = process.argv.includes("--yes");
const { importCalendarEvents } = await import("../api/_lib/calsync");

const r = await importCalendarEvents({ dryRun: !confirm });
console.log(`\nscanned ${r.scanned} upcoming event(s); ${r.imported} new, ${r.updated} edited, ${r.skipped} skipped (app-managed/declined/recurring/non-default).`);
for (const p of r.preview || []) {
  const tag = p.action === "updated" ? "↻ edited" : "+ new";
  console.log(`\n${tag}  ${p.date}  ${p.title}  [for: ${p.people.join(", ") || "—"}]`);
  for (const t of p.todos) console.log(`     ↳ ${t}`);
}
console.log(confirm ? "\nCOMMITTED to store." : "\nDRY RUN — re-run with --yes to apply.");
