#!/usr/bin/env tsx
// Mint a device session for a parent (for curl-based verification).
// Usage: npx tsx scripts/session.ts alex|sam   → prints a Cookie header value
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { createSession, userById } = await import("../api/_lib/auth");
const who = (process.argv[2] || "alex") as "alex" | "sam";
const user = userById(who);
if (!user) { console.error("unknown user"); process.exit(1); }
const id = await createSession(user);
console.log(`fhq_session=${id}`);
