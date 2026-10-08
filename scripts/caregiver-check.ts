#!/usr/bin/env tsx
// End-to-end check of the caregiver role (Grandma): what her app receives, what she can't reach,
// how Kimi treats her chat, and how her purchase approvals reach the parents. Uses a test-only
// email (set in this process), never texts anyone, and deletes everything it creates.
// A few dollars of API use.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const { CONFIG } = await import("../src/data/config");
const realEmail = CONFIG.caregivers.grandma.email;
if (!realEmail) (CONFIG.caregivers.grandma as { email: string }).email = "grandma-check@example.invalid"; // sign-in for this test only
const db = await import("../api/_lib/db");
const { memberName } = await import("../api/_lib/privacy");
const { createSession, userById, endSession } = await import("../api/_lib/auth");
const { proposeAction, latestPending } = await import("../api/_lib/actions");
const { getWorkBlocks, formatBlocks, getWorkCalConfig } = await import("../api/_lib/workcal");
const routes = {
  data: (await import("../api/_routes/data")).default,
  tasks: (await import("../api/_routes/tasks")).default,
  chat: (await import("../api/_routes/chat")).default,
  files: (await import("../api/_routes/files")).default,
  action: (await import("../api/_routes/action")).default,
  vault: (await import("../api/_routes/vault")).default,
  gmail: (await import("../api/_routes/gmail")).default,
  workcal: (await import("../api/_routes/workcal")).default,
  setup: (await import("../api/_routes/setup")).default,
  mutate: (await import("../api/_routes/mutate")).default,
};

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
async function call(route: keyof typeof routes, sid: string, opts: { method?: string; query?: Record<string, string>; body?: unknown } = {}) {
  let status = 200, body: any;
  const req: any = { method: opts.method || "GET", query: opts.query || {}, headers: { cookie: `fhq_session=${sid}`, host: "localhost" }, body: opts.body, url: "/" };
  const res: any = { statusCode: 200, setHeader() { return this; }, writeHead(c: number) { status = c; return this; }, status(c: number) { status = c; return this; }, json(b: any) { body = b; return this; }, send(b: any) { body = b; return this; }, end() { return this; } };
  await routes[route](req, res);
  return { status, body: typeof body === "string" ? (() => { try { return JSON.parse(body); } catch { return body; } })() : body };
}

const grandma = await createSession(userById("grandma")!);
const alex = await createSession(userById("alex")!);
const THREAD = "task-private-grandma";
const PAIR = "task-with-alex-grandma";
const created: string[] = [];
for (const t of [THREAD, PAIR]) if (!(await db.getTaskMeta(t))) created.push(t);
const { threadMembers, threadsFor } = await import("../src/data/threads");
let actionId = "";
try {
  // 1) What her app receives.
  const d = (await call("data", grandma)).body;
  const dj = (await call("data", alex)).body;
  check("signed in as the caregiver", d.me?.id === "grandma" && d.me?.role === "caregiver", JSON.stringify(d.me));
  check("sees the family calendar", d.events.length > 0 && d.events.length >= dj.events.filter((e: any) => !e.privateTo).length, `${d.events.length} events`);
  check("no spending", Array.isArray(d.spending) && d.spending.length === 0 && dj.spending.length > 0);
  check("no activity log", d.audit.length === 0);
  check("no parents' approvals or schedules", d.actions.every((a: any) => a.requester === "grandma" || a.privateTo === "grandma") && d.schedules.every((s: any) => s.privateTo === "grandma"), `${d.actions.length} actions, ${d.schedules.length} schedules`);
  check("sees household facts and kids", (d.profile?.facts?.length || 0) > 0 && d.kids.length > 0);

  // 2) Conversations and files.
  const main = (await call("tasks", grandma, { query: { id: "task-main" } })).body;
  check("can't read the parents' family chat", main.task === null);
  const jm = (await call("tasks", grandma, { query: { id: "task-private-alex" } })).body;
  check("can't read Alex's Just-me chat", jm.task === null);
  const list = (await call("tasks", grandma)).body.tasks as any[];
  check("task list has none of the parents' threads", !list.some((t) => t.id === "task-main" || t.id === "task-private-alex" || t.id === "task-private-sam"), `${list.length} listed`);
  const files = (await call("files", grandma)).body.files as any[];
  check("files: only her own and her chats'", files.every((f) => f.privateTo === "grandma" || (f.audience || []).includes("grandma")), `${files.length} visible`);

  // 3) Parent-only doors.
  for (const r of ["vault", "gmail", "workcal", "setup"] as const) {
    const s = (await call(r, grandma)).status;
    check(`${r} is parents-only`, s === 401 || s === 403, `HTTP ${s}`);
  }
  const k = await call("mutate", grandma, { method: "POST", body: { op: "upsert", collection: "kids", item: { id: "max" } } });
  check("can't edit the kids", k.status === 403, `HTTP ${k.status}`);

  // 4) Her purchase approvals: visible to both parents and to her; only a parent decides.
  const a = await proposeAction({ kind: "confirm_step", title: "(caregiver-check) Place order: paper towels", summary: "test", payload: { taskId: "task-web-caregiver-check", description: "(caregiver-check) Place order: paper towels" } as any, requestedBy: "agent", channel: "app", requester: "grandma" });
  actionId = a.id;
  check("parents see her request", (await call("data", alex)).body.actions.some((x: any) => x.id === a.id));
  check("she sees its status", (await call("data", grandma)).body.actions.some((x: any) => x.id === a.id));
  check("a text APPROVE from either parent would find it", (await latestPending("alex"))?.id === a.id && (await latestPending("sam"))?.id === a.id);
  const dec = await call("action", grandma, { method: "POST", body: { id: a.id, decision: "approve" } });
  check("she can't approve it", dec.status === 403, `HTTP ${dec.status}`);

  // 4b) Shared chats: who's in which.
  check("thread ids: canonical only", threadMembers("task-with-alex-sam") === null && threadMembers("task-with-grandma-alex") === null && String(threadMembers(PAIR)) === "alex,grandma");
  check("her chats: Just me, Alex, Sam, Everyone", threadsFor("grandma").join(",") === "task-private-grandma,task-with-alex-grandma,task-with-sam-grandma,task-with-alex-sam-grandma");
  check("Alex's chats include the family chat", threadsFor("alex").includes("task-main") && !threadsFor("grandma").includes("task-main"));
  for (const t of ["task-private-alex", "task-with-alex-sam", "task-main-x"]) {
    const s = (await call("chat", grandma, { method: "POST", body: { message: "(caregiver-check) hi", thread: t } })).status;
    check(`she can't post to ${t}`, s === 403, `HTTP ${s}`);
  }
  const sam = await createSession(userById("sam")!);
  const sp = (await call("chat", sam, { method: "POST", body: { message: "(caregiver-check) hi", thread: PAIR } })).status;
  check("Sam can't post to the Alex & Grandma chat", sp === 403, `HTTP ${sp}`);
  const sr = (await call("tasks", sam, { query: { id: PAIR } })).body;
  check("Sam can't read the Alex & Grandma chat", !sr?.task);
  await endSession(sam);

  // 4c) A file scoped to the Alex & Grandma chat: both of them see it, Sam doesn't.
  const fid = `file-caregiver-check-${Date.now()}`;
  await db.saveFile({ id: fid, title: "(caregiver-check) pickup plan", createdAt: new Date().toISOString(), audience: ["alex", "grandma"], thread: PAIR } as any);
  try {
    const seen = async (sid: string) => ((await call("files", sid)).body.files as any[]).some((f) => f.id === fid);
    const other = await createSession(userById("sam")!);
    check("shared-chat file: Alex and Grandma see it, Sam doesn't", (await seen(alex)) && (await seen(grandma)) && !(await seen(other)));
    await endSession(other);
  } finally {
    await db.redis.del(`file:${fid}`);
    await db.redis.srem("files_index", fid);
  }

  // 5) Work calendars: availability only, never titles.
  if (await getWorkCalConfig("alex")) {
    const from = new Date(), to = new Date(Date.now() + 7 * 86400000);
    const blocks = await getWorkBlocks("alex", from, to);
    const txt = formatBlocks(blocks, { availabilityOnly: true });
    const leaked = blocks.map((b) => b.title).filter((t) => t && t !== "Busy" && t.length > 3 && txt.includes(t));
    check("work calendar: no meeting titles in her view", leaked.length === 0, leaked.slice(0, 2).join(", "));
  }

  // 6) Kimi in her chat (real model). "Family" is ignored for her: she always talks in her own thread.
  const ask = async (message: string) => {
    const r = await call("chat", grandma, { method: "POST", body: { message, thread: "family" } });
    const t = await db.getTask(THREAD);
    const tools = (t?.log || []).filter((e) => e.kind === "tool").slice(-6).map((e) => e.text.split(":")[0]);
    return { reply: String(r.body?.reply || ""), tools };
  };
  const before = ((await db.getTaskMeta("task-main"))?.log || []).length;
  const s1 = await ask("(Test) How much did we spend on DoorDash this month?");
  check("no spending tool for her", !s1.tools.includes("get_spending"), s1.reply.replace(/\n/g, " ").slice(0, 120));
  check("her message went to her own chat, not the family chat", ((await db.getTaskMeta("task-main"))?.log || []).length === before && !!(await db.getTaskMeta(THREAD)));
  const s2 = await ask("(Test) Is Alex free Tuesday afternoon? What meetings does he have?");
  check("calls her Grandma", /grandma/i.test(s1.reply + s2.reply), s2.reply.replace(/\n/g, " ").slice(0, 160));

  // 7) The Alex & Grandma chat (real model): Alex can post there, and Kimi knows who's in it.
  const pr = await call("chat", alex, { method: "POST", body: { message: "(Test, don't add anything) Who's in this chat with us? One line.", thread: PAIR } });
  const pt = await db.getTask(PAIR);
  check("Alex can talk in the Alex & Grandma chat", pr.status === 200 && !!pt, String(pr.body?.reply || pr.body?.error || "").replace(/\n/g, " ").slice(0, 140));
  check("Kimi knows Grandma is in it", /grandma/i.test(String(pr.body?.reply || "")) && !new RegExp(`\\b${memberName("sam")}\\b.*\\b(here|in this chat)\\b`, "i").test(String(pr.body?.reply || "")));
  const gr = (await call("tasks", grandma, { query: { id: PAIR } })).body;
  check("Grandma sees that chat", (gr?.task?.log || []).some((e: any) => e.kind === "user"));
} catch (e) {
  fail++;
  console.error("✗ check crashed:", e);
} finally {
  if (actionId) await db.removeItems("actions", [actionId]);
  const audit = await db.getCollection("audit");
  await db.setCollection("audit", audit.filter((x) => !String(x.summary).includes("(caregiver-check)")));
  for (const t of created) { await db.redis.del(`task:${t}`, `task_thread:${t}`, `reactions:${t}`); await db.redis.srem("tasks_active", t); await db.redis.srem("tasks_index", t); }
  await endSession(grandma); await endSession(alex);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
