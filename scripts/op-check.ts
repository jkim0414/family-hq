#!/usr/bin/env tsx
// Verify the 1Password service-account hookup: lists the vaults the token can
// see, then the logins in the HQ vault (titles/sites/usernames only — no secrets).
// Usage: npx tsx scripts/op-check.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
  console.error("OP_SERVICE_ACCOUNT_TOKEN is not set in .env.local");
  process.exit(1);
}
const { createClient } = await import("@1password/sdk");
const { listOpLogins, opVaultName, invalidateOpCache } = await import("../api/_lib/onepassword");

const c = await createClient({ auth: process.env.OP_SERVICE_ACCOUNT_TOKEN, integrationName: "Family HQ", integrationVersion: "v1.0.0" });
const vaults = await c.vaults.list();
console.log("Vaults visible to the service account:", vaults.map((v) => `${v.title} (${v.id})`).join(", ") || "(none)");
console.log(`Looking for vault "${opVaultName()}"…`);
await invalidateOpCache();
const logins = await listOpLogins();
console.log(`${logins.length} login(s):`);
for (const l of logins) console.log(`  • ${l.title} — ${l.site || "(no site)"} ${l.username ? `(user: ${l.username})` : ""}${l.hasOtp ? " · 2FA" : ""}`);
process.exit(0);
