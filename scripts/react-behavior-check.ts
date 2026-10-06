#!/usr/bin/env tsx
// Are tapbacks part of Kimi's voice? Sends everyday messages on throwaway app threads (never texted)
// and reports her reaction + reply for each. Fails if anything gets filed. ~$1 of API use.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const db = await import("../api/_lib/db");
const agent = await import("../api/_lib/agent");
const { getReactions } = await import("../api/_lib/reactions");
const count = async () => (await db.getCollection("schedules")).length + (await db.getCollection("todos")).length + (await db.getCollection("events")).length;
const before = await count();
const stamp = Date.now().toString(36);
type Want = { react: "any" | "none" | "only" | string[]; text: boolean };
const kids = (await db.getCollection("kids")).map((k: any) => k.firstName);
const [k1, k2, k3] = [kids[0] || "Max", kids[1] || "Theo", kids[2] || "Ava"];
const CASES: [string, "alex" | "sam", string, Want][] = [
  ["kid first", "alex", `${k1} lost his first tooth!!`, { react: ["❤️", "‼️"], text: true }],
  ["funny kid story", "sam", `lol ${k2} just asked if the tooth fairy takes Venmo`, { react: ["😂"], text: true }],
  ["big good news", "sam", "We got off the waitlist for the Spanish immersion camp!!", { react: ["❤️", "‼️"], text: true }],
  ["thanks", "alex", "Thanks Kimi!", { react: "only", text: false }],
  ["ok", "sam", "sounds good", { react: "only", text: false }],
  ["logistics question", "alex", `What time is ${k2}'s swim tomorrow?`, { react: "none", text: true }],
  ["weather question", "sam", "Is it supposed to rain Saturday?", { react: "none", text: true }],
  ["sick kid", "sam", `${k3} has a fever, poor thing. Nothing to do, just a heads up.`, { react: ["❤️", "none"], text: true }],
];
let pass = 0;
let i = 0;
for (const [label, who, msg, want] of CASES) {
  const id = `task-verify-react-${stamp}-${i++}`;
  const t: any = agent.newTask(id, "test", who, "app");
  const prior = "It's Saturday 11–2 at the school field! ☀️";
  (t.thread as any[]).push({ role: "user", content: `[${who === "alex" ? "Alex" : "Sam"} · app · earlier]\nWhat time is the school picnic?` }, { role: "assistant", content: prior });
  t.log.push({ at: new Date(Date.now() - 60000).toISOString(), kind: "assistant", text: prior });
  agent.addUserMessage(t, who, "app", msg);
  await db.saveTask(t);
  const reply = await agent.runAgent(t, { deadlineMs: Date.now() + 120_000 });
  const rx = Object.values(await getReactions(id)).flat().filter((x: any) => x.by === "kimi").map((x: any) => x.emoji);
  const r = rx[0] || "none";
  const reactOk = want.react === "any" ? true : want.react === "none" ? !rx.length : want.react === "only" ? rx.length === 1 : want.react.includes(r);
  const textOk = want.text ? !!reply : !reply;
  const ok = reactOk && textOk && !/😂|‼️/.test(label === "sick kid" ? r : "");
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${r}${reply ? ` + "${reply.replace(/\n/g, " ").slice(0, 90)}"` : " (no text)"}`);
  await db.redis.del(`task:${id}`, `task_thread:${id}`, `reactions:${id}`);
  await db.redis.srem("tasks_active", id);
}
const created = (await count()) - before;
console.log(`\n${pass}/${CASES.length} as expected; items filed during the check: ${created}`);
process.exit(pass === CASES.length && !created ? 0 : 1);
