#!/usr/bin/env tsx
// One-time: turn the old free-text household sections (and the append-only "Learned facts" block)
// into typed facts — one statement each, with a topic and who it's about, duplicates merged and
// superseded ones dropped. Backs up the old profile first. Prints the result for review.
//   npx tsx scripts/migrate-facts.ts          → dry run (prints, saves nothing)
//   npx tsx scripts/migrate-facts.ts --save   → saves (old profile kept at profile_backup:<time>)
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const db = await import("../api/_lib/db");
const { FACT_TOPICS, isFactTopic, newFactId, renderFacts } = await import("../src/data/facts");

const raw: any = await db.redis.get("profile");
if (!raw?.sections?.length) {
  console.log(raw?.facts ? "Already migrated (profile has facts)." : "No old sections to migrate.");
  process.exit(0);
}
const old = raw.sections.map((s: any) => `## ${s.title} [${s.key}]\n${s.body}`).join("\n\n");

const prompt = `Below are a family's household notes, written over time as free text. Rewrite them as a clean list of standalone facts for their assistant.

Rules:
- One fact per item: a short sentence that stands on its own and names who it's about ("Ava's swim lessons are Saturdays at 9am").
- Merge duplicates and near-duplicates. When two notes conflict, keep the newer one (dates in parentheses mark when a note was learned) and drop the superseded one. Drop the date stamps.
- Keep every distinct detail (times, names, phone numbers, addresses, rules of thumb). Don't invent anything.
- Topic: one of ${FACT_TOPICS.map((t) => `"${t.id}" (${t.label})`).join(", ")}.
- about: ids of who it's about, from "alex", "sam", "grandma" (Grandma, Sam's mom), "max", "theo", "ava"; empty for the whole household.

Return ONLY a JSON array: [{"topic": "...", "about": ["..."], "text": "..."}]

NOTES:
${old}`;

const client = new Anthropic();
const r = await client.messages.create({ model: "claude-opus-5", max_tokens: 8000, messages: [{ role: "user", content: prompt }] });
const text = r.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
const items: any[] = JSON.parse(json);
const now = new Date().toISOString();
const facts = items
  .filter((x) => typeof x?.text === "string" && x.text.trim())
  .map((x) => ({ id: newFactId(), topic: isFactTopic(x.topic) ? x.topic : "other", ...(Array.isArray(x.about) && x.about.length ? { about: x.about.map(String) } : {}), text: x.text.trim(), updatedAt: now }));

console.log(`${raw.sections.length} sections (${old.length} chars) → ${facts.length} facts (${facts.reduce((a, f) => a + f.text.length, 0)} chars)\n`);
console.log(renderFacts(facts as any));

if (process.argv.includes("--save")) {
  const key = `profile_backup:${now}`;
  await db.redis.set(key, raw);
  await db.setProfile({ facts: facts as any, people: raw.people || [] });
  console.log(`\nSaved. Old profile backed up at ${key}.`);
} else console.log("\n(dry run — pass --save to save)");
process.exit(0);
