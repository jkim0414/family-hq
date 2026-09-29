#!/usr/bin/env tsx
// Local end-to-end test of the browser agent + approval gate, no Browserbase
// needed: launches a local Chromium exposing CDP, runs a background browser
// task against a harmless demo form, expects the final "Submit order" click to
// be BLOCKED → request_approval → task waits; then approves and expects the
// task to submit and report. Cleans up its own records.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const PORT = 9333;
process.env.BROWSER_CDP_URL = `http://127.0.0.1:${PORT}`;

const { chromium } = await import("playwright");
const local = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });

const { newTask, runAgent } = await import("../api/_lib/agent");
const { decideAction } = await import("../api/_lib/actions");
const { getTask, saveTask, getCollection, setCollection, redis } = await import("../api/_lib/db");

const id = `task-web-test-${Date.now().toString(36)}`;
const task = newTask(id, "Demo pizza form (test)", "alex", "app");
task.kind = "browser";
(task.thread as any[]).push({
  role: "user",
  content:
    "[Alex · app · test]\nGOAL: Fill out the demo pizza order form at https://httpbin.org/forms/post and submit it.\nDETAILS: Customer name 'HQ Test', telephone 555-0100, email hq@example.com, size Medium, topping Cheese, delivery time 18:30, comments 'automated test'. Submitting the order is the irreversible step — ask for approval before it. After submitting, report what the confirmation page shows.",
});
await saveTask(task);

const show = (t: any, n = 12) => t.log.slice(-n).map((e: any) => `  ${e.kind.padEnd(9)} ${e.text.slice(0, 140)}`).join("\n");

console.log("=== phase 1: work until it must ask for approval ===");
let reply = await runAgent(task, { deadlineMs: Date.now() + 300_000 });
let t = (await getTask(id))!;
console.log(`reply: ${JSON.stringify(reply)} | status: ${t.status} | waitingOn: ${t.waitingOn}`);
console.log(show(t));

const pending = (await getCollection("actions")).filter((a: any) => a.kind === "confirm_step" && a.status === "proposed" && a.payload.taskId === id).pop();
console.log("\npending approval:", pending ? `${pending.title} | screenshot ${Math.round((pending.payload.screenshot?.length || 0) / 1024)}KB | url ${pending.payload.url}` : "NONE");

let ok = false;
if (pending && t.status === "waiting") {
  console.log("\n=== phase 2: approve → task resumes and submits ===");
  await decideAction(pending.id, "approve", "alex");
  t = (await getTask(id))!;
  console.log(`after approve: status ${t.status} | approvedUntil ${t.approvedUntil}`);
  reply = await runAgent(t, { deadlineMs: Date.now() + 300_000 });
  t = (await getTask(id))!;
  console.log(`final reply: ${reply.slice(0, 500)}`);
  console.log(show(t, 10));
  ok = /HQ Test|submitted|form|order/i.test(reply);
}
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);

// cleanup
await setCollection("actions", (await getCollection("actions")).filter((a: any) => a.payload?.taskId !== id));
await setCollection("audit", (await getCollection("audit")).filter((e: any) => !(pending && e.ref === pending.id)));
await redis.del(`task:${id}`);
await redis.srem("tasks_index", id);
await redis.del(`task_lock:${id}`);
await local.close();
process.exit(ok ? 0 : 1);
