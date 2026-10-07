#!/usr/bin/env tsx
// One-time: tag existing purchases with a spending category (new receipts get one when read).
//   npx tsx scripts/categorize-spending.ts [--save]
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const db = await import("../api/_lib/db");
const { SPEND_CATEGORIES, toSpendCategory } = await import("../src/data/spending");
const rows = await db.getCollection("spending");
const todo = rows.filter((r) => !r.category);
const client = new Anthropic();
for (let i = 0; i < todo.length; i += 50) {
  const batch = todo.slice(i, i + 50);
  const r = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 3000,
    messages: [
      {
        role: "user",
        content: `Categorize each family purchase as one of: ${SPEND_CATEGORIES.map((c) => `${c.id} (${c.label})`).join(", ")}.\nReply with ONLY a JSON array of category ids, one per line item, in order.\n\n${batch.map((p, j) => `${j}. ${p.merchant} — ${p.description} — $${p.amount}`).join("\n")}`,
      },
    ],
  });
  const text = r.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  const cats: string[] = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  batch.forEach((p, j) => (p.category = toSpendCategory(cats[j])));
}
const tally: Record<string, number> = {};
for (const r of rows) tally[r.category || "?"] = (tally[r.category || "?"] || 0) + 1;
console.log(tally);
for (const p of todo.slice(0, 12)) console.log(`  ${p.category}: ${p.merchant} — ${p.description}`);
if (process.argv.includes("--save")) {
  // Re-read and merge, so a receipt that arrived meanwhile isn't lost.
  const fresh = await db.getCollection("spending");
  const byId = new Map(todo.map((p) => [p.id, p.category]));
  await db.setCollection("spending", fresh.map((p) => (byId.has(p.id) && !p.category ? { ...p, category: byId.get(p.id) } : p)));
  console.log("Saved.");
} else console.log("(dry run — pass --save)");
process.exit(0);
