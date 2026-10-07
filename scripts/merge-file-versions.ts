#!/usr/bin/env tsx
// One-time: files saved as separate versions ("Weekend Plan v2", "… v3") become
// one file — the newest keeps its id and link, the older ones become its history, and their old
// links redirect (file_moved:<id>). Only merges files with the same title (minus "v2") and the
// same visibility.  npx tsx scripts/merge-file-versions.ts [--save]
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const db = await import("../api/_lib/db");
const save = process.argv.includes("--save");

const base = (t: string) => t.replace(/\s+v\d+\b/i, "").replace(/\s+/g, " ").trim();
const docs = (await Promise.all((await db.listFileIds()).map((i) => db.getFile(i)))).filter((d): d is NonNullable<typeof d> => !!d);
const groups = new Map<string, typeof docs>();
for (const d of docs) {
  const k = `${base(d.title).toLowerCase()}|${d.privateTo || ""}|${(d.audience || []).join(",")}`;
  groups.set(k, [...(groups.get(k) || []), d]);
}
let merged = 0;
for (const g of groups.values()) {
  if (g.length < 2) continue;
  g.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const keep = g[g.length - 1];
  const older = g.slice(0, -1);
  console.log(`"${base(keep.title)}": keep ${keep.id} (${keep.title}); history ← ${older.map((o) => `${o.id} (${o.title})`).join(", ")}`);
  if (!save) continue;
  keep.versions = [...older.map((o) => ({ title: o.title, markdown: o.markdown, updatedAt: o.updatedAt || o.createdAt })), ...(keep.versions || [])];
  keep.title = base(keep.title);
  keep.createdAt = older[0].createdAt;
  await db.saveFile(keep);
  for (const o of older) {
    await db.redis.set(`file_moved:${o.id}`, keep.id);
    await db.redis.del(`file:${o.id}`);
    await db.redis.srem("files_index", o.id);
  }
  merged++;
}
console.log(save ? `Merged ${merged} group(s).` : "(dry run — pass --save)");
process.exit(0);
