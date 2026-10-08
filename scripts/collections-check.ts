#!/usr/bin/env tsx
// The per-item collection store (api/_lib/db.ts): migration from the old one-value format, writers
// that overlap without losing each other's changes, deletions, order. Runs in its own namespace
// (DATA_NS) with a copy of the real data; the live collections are only read, never written.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const NS = `test-${Date.now().toString(36)}:`;
process.env.DATA_NS = NS;
const db = await import("../api/_lib/db");
const { redis } = db;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join(",");

try {
  // ── Migration, from a copy of the real data (live keys: old format until the new code runs, then hashes) ──
  const live = async (name: string) => (await redis.exists(`c:${name}`)) ? null : await redis.get<any[]>(name);
  for (const name of ["events", "todos", "comms", "spending", "kids"]) {
    const src = (await live(name)) || [];
    await redis.set(`${NS}${name}`, src);
    const got = await db.getCollection(name as any);
    const same = JSON.stringify(name === "spending" ? [...src].sort((a, b) => String(b.date).localeCompare(String(a.date))) : src) === JSON.stringify(got);
    check(`${name}: migrates intact, in order`, same, `${src.length} items`);
    check(`${name}: old value kept as a backup`, !(await redis.exists(`${NS}${name}`)) && !!(await redis.exists(`${NS}bak:${name}:2026-10-08`)));
  }
  const state = await db.getState();
  check("getState matches per-collection reads", ids(state.events) === ids(await db.getCollection("events")) && ids(state.todos) === ids(await db.getCollection("todos")));

  // ── The race that used to lose writes ──
  // Two writers read the same to-dos; one marks A done, the other adds C and edits B. Both save.
  await db.replaceCollection("todos", [{ id: "A", title: "a", done: false }, { id: "B", title: "b", done: false }] as any);
  const w1 = await db.getCollection("todos");
  const w2 = await db.getCollection("todos");
  w1.find((t) => t.id === "A")!.done = true;
  w2.find((t) => t.id === "B")!.title = "b edited";
  w2.push({ id: "C", title: "c", done: false } as any);
  await db.setCollection("todos", w2);
  await db.setCollection("todos", w1); // the stale writer finishes last
  const after = await db.getCollection("todos");
  check("overlapping writers both keep their changes", after.find((t) => t.id === "A")?.done === true && after.find((t) => t.id === "B")?.title === "b edited" && !!after.find((t) => t.id === "C"), ids(after));
  check("…in insertion order", ids(after) === "A,B,C");

  // An item appended (ingest) while a chat writer holds an older read survives that writer's save.
  const chat = await db.getCollection("todos");
  await db.appendItems("todos", [{ id: "D", title: "from ingest", done: false }] as any);
  chat.find((t) => t.id === "C")!.done = true;
  await db.setCollection("todos", chat);
  const after2 = await db.getCollection("todos");
  check("an append during another writer's work survives", !!after2.find((t) => t.id === "D") && after2.find((t) => t.id === "C")?.done === true);

  // Deletions: filtering out what was read removes it — and only it.
  const del = await db.getCollection("todos");
  await db.appendItems("todos", [{ id: "E", title: "late", done: false }] as any);
  await db.setCollection("todos", del.filter((t) => t.id !== "A"));
  check("a filtered-out item is deleted; one added meanwhile isn't", ids(await db.getCollection("todos")) === "B,C,D,E");
  await db.removeItems("todos", ["B", "C", "D", "E"]);
  check("removeItems empties it", (await db.getCollection("todos")).length === 0);

  // An update keeps its place; unchanged items aren't rewritten.
  await db.replaceCollection("events", [{ id: "x" }, { id: "y" }, { id: "z" }] as any);
  const ev = await db.getCollection("events");
  (ev[0] as any).title = "x2";
  await db.setCollection("events", ev);
  check("an edited item keeps its place", ids(await db.getCollection("events")) === "x,y,z");

  // Trimming keeps the newest.
  await db.replaceCollection("audit", Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, at: "", kind: "x", summary: "", by: "t" })) as any);
  await db.trimCollection("audit", 5);
  check("trim keeps the newest", ids(await db.getCollection("audit")) === "a7,a8,a9,a10,a11");

  // Many writers at once.
  await db.replaceCollection("todos", [] as any);
  await Promise.all(Array.from({ length: 20 }, (_, i) => db.appendItems("todos", [{ id: `p${i}`, title: `${i}`, done: false }] as any)));
  const par = await db.getCollection("todos");
  check("20 simultaneous adds all land", par.length === 20, `${par.length}`);
} finally {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: `${NS}*`, count: 500 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length) await redis.del(...keys);
  console.log(`(removed ${keys.length} test keys)`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
