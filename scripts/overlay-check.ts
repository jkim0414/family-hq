#!/usr/bin/env tsx
// The guarantee that local runs can't change the family's data (api/_lib/overlay.ts): every kind
// of write the app makes, done through the data layer, is visible to this run — and the real
// data is byte-for-byte unchanged, read with a separate client that bypasses the overlay.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
delete process.env.LIVE_DATA;
const { Redis } = await import("@upstash/redis");
const live = new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! });
const db = await import("../api/_lib/db");

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
const KEYS = ["c:todos", "c:events", "c:audit", "profile", "tasks_index", "files_index", "state_ver", "private_notes:alex"];
const fingerprint = async () => {
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    const t = await live.type(k);
    // Item by item, in a fixed order (a hash comes back in no particular order). The live app can
    // also write in the meantime (a calendar sync, an audit line), so the check that matters is
    // below: nothing this run did is in the real data.
    const h = t === "hash" ? ((await live.hgetall(k)) as Record<string, unknown>) : null;
    out[k] = JSON.stringify(h ? Object.keys(h).sort().map((f) => [f, h[f]]) : t === "set" ? (await live.smembers(k)).sort() : await live.get(k));
  }
  return out;
};

check("local runs write to an overlay", db.isOverlay);
const before = await fingerprint();
const tag = `ov${Date.now().toString(36)}`;

// Every kind of write.
const todos = await db.getCollection("todos");
const victim = todos.find((t) => !t.done);
await db.appendItems("todos", [{ id: `todo-${tag}`, title: `Overlay test ${tag}`, done: false, priority: "normal" } as any]);
if (victim) { victim.title = `${victim.title} (edited ${tag})`; await db.setCollection("todos", todos); }
const someEvent = (await db.getCollection("events"))[0];
if (someEvent) await db.removeItems("events", [someEvent.id]);
await db.addAudit({ kind: "executed", summary: `overlay ${tag}`, by: "alex" } as any);
const p = await db.getProfile();
p.facts.push({ id: `f-${tag}`, topic: "other", text: `Overlay fact ${tag}`, updatedAt: new Date().toISOString() } as any);
await db.setProfile(p);
const { newTask } = await import("../api/_lib/agent");
await db.saveTask(newTask(`task-${tag}`, "overlay", "alex", "app"));
await db.saveFile({ id: `file-${tag}`, title: "overlay", markdown: "x", createdAt: new Date().toISOString(), updatedAt: "" } as any);
await db.redis.incr("state_ver");
const { addPrivateNote } = await import("../api/_lib/privacy");
await addPrivateNote("alex", `overlay note ${tag}`);

// This run sees its writes…
const t2 = await db.getCollection("todos");
check("…this run sees what it added", t2.some((t) => t.id === `todo-${tag}`));
check("…and what it edited", !victim || t2.some((t) => t.id === victim.id && t.title.includes(tag)));
check("…and what it deleted", !someEvent || !(await db.getCollection("events")).some((e) => e.id === someEvent.id));
check("…and its fact, chat, file", (await db.getProfile()).facts.some((f) => f.id === `f-${tag}`) && !!(await db.getTaskMeta(`task-${tag}`)) && !!(await db.getFile(`file-${tag}`)));

// …and the family's data didn't change at all.
const after = await fingerprint();
const changed = KEYS.filter((k) => before[k] !== after[k]);
check("the real data is unchanged", changed.length === 0, changed.length ? `changed: ${changed.join(", ")} (the live app may have written meanwhile — see the specific checks)` : `${KEYS.length} keys identical`);
const realTodos = JSON.stringify(await live.hgetall("c:todos"));
check("no test item in the real to-dos, and the edit didn't land there", !realTodos.includes(tag));
check("the deleted event is still in the real calendar", !someEvent || !!(await live.hget("c:events", someEvent.id)));
check("no test fact, chat, file, or note in the real data", !JSON.stringify(await live.get("profile")).includes(tag) && !(await live.exists(`task:task-${tag}`)) && !(await live.exists(`file:file-${tag}`)) && !JSON.stringify(await live.get("private_notes:alex")).includes(tag));

await db.dropTestData();
check("the overlay is dropped at the end", (await live.keys("ovl:*")).every((k) => !k.includes(tag)));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
