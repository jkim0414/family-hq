#!/usr/bin/env tsx
// End-to-end check of the CAPTCHA takeover: a real browser task on Google's reCAPTCHA demo page
// should ask for a takeover (not try to solve it); the link should open a live browser for the
// person it was sent to and nobody else; "Done" should hand the browser back to Kimi.
// Notifications are switched off in this process (no push, email, or texts reach anyone).
// Real Browserbase + model use; everything it creates is removed.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
process.env.TAKEOVER_NO_KICK = "1";
for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "IMAP_USER", "IMAP_PASS", "SMTP_USER", "SMTP_PASS", "TWILIO_ACCOUNT_SID"]) delete process.env[k];
const a = await import("../api/_lib/agent");
const db = await import("../api/_lib/db");
const web = await import("../api/_lib/browser");
const { createSession, userById, endSession } = await import("../api/_lib/auth");
const route = (await import("../api/_routes/takeover")).default;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
async function call(sid: string, opts: { method?: string; query?: Record<string, string>; body?: unknown }) {
  let status = 200, body = "";
  const req: any = { method: opts.method || "GET", query: opts.query || {}, headers: { cookie: `fhq_session=${sid}`, host: "localhost" }, body: opts.body, url: "/" };
  const res: any = { setHeader() { return this; }, status(c: number) { status = c; return this; }, send(b: any) { body = String(b); return this; }, json(b: any) { body = JSON.stringify(b); return this; }, end() { return this; } };
  await route(req, res);
  return { status, body };
}

const id = `task-web-takeover-check-${Date.now().toString(36)}`;
const parent = `task-verify-takeover-${Date.now().toString(36)}`;
const alex = await createSession(userById("alex")!);
const sam = await createSession(userById("sam")!);
let sessionId: string | undefined;
try {
  const t: any = a.newTask(id, "(takeover check) submit the reCAPTCHA demo form", "alex", "app");
  t.kind = "browser"; t.privateTo = "alex"; t.parentThread = parent;
  t.parentRequest = "PARENT: test — submit the form on the Google reCAPTCHA demo page";
  t.thread.push({ role: "user", content: "[Alex · app]\nGOAL: Test run: open https://www.google.com/recaptcha/api2/demo and submit its form.\nWork this in the browser. When finished (or stuck), reply with the outcome." });
  await db.saveTask(t);
  await a.runAgent(t, { deadlineMs: Date.now() + 200_000 });
  const after = await db.getTask(id);
  const tools = (after?.log || []).filter((e) => e.kind === "tool").map((e) => e.text.split(":")[0]);
  check("Kimi asks for a takeover instead of solving it", !!after?.takeover && tools.includes("request_takeover"), tools.join(", "));
  check("the task waits (browser released meanwhile)", after?.status === "waiting" && !after?.browserSessionId);
  const posted = ((await db.getTaskMeta(parent))?.log || []).map((e) => e.text).join("\n");
  check("the link is posted in the chat it came from", /\/takeover\/[A-Za-z0-9_-]{20,}/.test(posted), posted.slice(0, 160));
  const token = after!.takeover!.token;

  const nope = await call(sam, { query: { token } });
  check("only the person it was sent to can open it", nope.status === 403, `Sam: HTTP ${nope.status}`);
  const bad = await call(alex, { query: { token: "x".repeat(24) } });
  check("a wrong link says expired", bad.status === 404);
  const open = await call(alex, { query: { token } });
  sessionId = (await db.getTask(id))?.takeover?.sessionId;
  check("opening it starts a live browser at that page", open.status === 200 && /<iframe src="https:\/\/[^"]*browserbase/.test(open.body) && !!sessionId && (await web.sessionRunning(sessionId)), `HTTP ${open.status}`);
  const again = await call(alex, { query: { token } });
  check("opening it again reuses the same browser", again.status === 200 && (await db.getTask(id))?.takeover?.sessionId === sessionId);

  const done = await call(alex, { method: "POST", body: { token, action: "done" } });
  const resumed = await db.getTask(id);
  check("Done hands the same browser back to Kimi", done.status === 200 && !resumed?.takeover && resumed?.browserSessionId === sessionId && resumed?.status === "running" && /took over the browser/.test(JSON.stringify(resumed?.thread.slice(-1))));
  const reuse = await call(alex, { query: { token } });
  check("the link stops working once used", reuse.status === 404);
} catch (e) {
  fail++;
  console.error("✗ check crashed:", e);
} finally {
  const t = await db.getTask(id);
  await web.releaseSession(sessionId || t?.takeover?.sessionId || t?.browserSessionId).catch(() => {});
  if (t?.takeover) await db.redis.del(`takeover:${t.takeover.token}`);
  for (const x of [id, parent]) { await db.redis.del(`task:${x}`, `task_thread:${x}`, `reactions:${x}`); await db.redis.srem("tasks_index", x); await db.redis.srem("tasks_active", x); }
  await endSession(alex); await endSession(sam);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
