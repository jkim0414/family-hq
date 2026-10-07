import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "../_lib/auth.js";
import { getTask, saveTask, redis } from "../_lib/db.js";
import { openForHuman, sessionRunning, liveViewUrl, releaseSession } from "../_lib/browser.js";
import { runDueTasks } from "../_lib/agent.js";
import { memberName } from "../_lib/privacy.js";

// GET  /takeover/:token  (→ /api/router?path=takeover&token=…)  the live browser, for a person to
//                        get past a CAPTCHA Kimi can't. Signed-in, and only for whom it was sent to.
// POST /api/takeover  { token, action: "done" | "cancel" }  hand the browser back to Kimi.
//
// The browser is started when the link is opened (nothing runs while it sits unopened): a fresh
// session on Kimi's profile (signed in), at the page where she stopped. Kimi continues in it.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Family HQ</title>
<style>
:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:16px;background:#f8fafc;color:#0f172a}
@media (prefers-color-scheme:dark){body{background:#0b0b0c;color:#f1f5f9}.card{background:#18181b!important;border-color:#27272a!important}.sub{color:#a1a1aa!important}}
.card{max-width:980px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:16px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#64748b;font-size:14px;margin:0 0 12px}
iframe{width:100%;height:68vh;border:1px solid #cbd5e1;border-radius:12px;background:#000}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}button,a.btn{font:inherit;font-size:15px;font-weight:600;border:0;border-radius:999px;padding:12px 18px;cursor:pointer;text-decoration:none}
.go{background:#16a34a;color:#fff}.alt{background:#e2e8f0;color:#0f172a}.lnk{background:transparent;color:#2563eb;padding:12px 4px}
</style></head><body><div class="card">${body}</div></body></html>`;

async function taskFor(token: string) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  const id = await redis.get<string>(`takeover:${token}`);
  const task = id ? await getTask(id) : null;
  return task?.takeover?.token === token ? task : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "text/html; charset=utf-8");
  // The live view is Browserbase's page in a frame; this page itself runs no script.
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-src https://*.browserbase.com; form-action 'self'; base-uri 'none'");
  const user = await requireUser(req);
  if (!user) return res.status(401).send(page("Sign in", `<h1>Sign in first</h1><p class="sub">This link opens a browser signed in to the family's accounts. <a href="/">Sign in to Family HQ</a>, then open the link again.</p>`));

  const body = typeof req.body === "string" ? Object.fromEntries(new URLSearchParams(req.body)) : req.body || {};
  const token = String((req.method === "POST" ? body.token : req.query.token) || "");
  const task = await taskFor(token);
  if (!task || !task.takeover) return res.status(404).send(page("Link expired", `<h1>This link has expired</h1><p class="sub">Kimi has moved on (or the 30 minutes ran out). Check the chat for where things stand.</p><div class="row"><a class="btn alt" href="/chat">Open chat</a></div>`));
  const t = task.takeover;
  if (!t.to.includes(user.id)) return res.status(403).send(page("Not yours", `<h1>This one was sent to ${esc(t.to.map(memberName).join(" and "))}</h1>`));

  if (req.method === "POST") {
    const done = body.action === "done";
    const who = memberName(user.id);
    if (done) {
      if (t.sessionId) task.browserSessionId = t.sessionId; // continue in the browser they used
      (task.thread as Anthropic.MessageParam[]).push({ role: "user", content: `[${who} · took over the browser]\nI handled it ("${t.reason}"). Continue where you left off — you're in the same browser; browse_read first.` });
    } else {
      await releaseSession(t.sessionId).catch(() => {});
      (task.thread as Anthropic.MessageParam[]).push({ role: "user", content: `[${who} · takeover]\nI'm not going to do this step now. Stop and report where things stand.` });
    }
    task.log.push({ at: new Date().toISOString(), kind: "user", who, text: done ? `Took over the browser and handled: ${t.reason}` : "Declined to take over." });
    task.takeover = undefined;
    task.waitingOn = undefined;
    task.followupNote = undefined;
    task.status = "running";
    task.nextCheckAt = new Date().toISOString();
    await saveTask(task);
    await redis.del(`takeover:${token}`);
    // Pick it up now rather than at the next cron tick (tests set TAKEOVER_NO_KICK: never run real tasks locally).
    if (process.env.TAKEOVER_NO_KICK !== "1") waitUntil(runDueTasks(240_000).catch((e) => console.error("resume after takeover failed", e)));
    return res.status(200).send(page("Thanks", `<h1>${done ? "Thanks — Kimi's back on it ✨" : "Okay — Kimi will stop and report"}</h1><p class="sub">${done ? "She's continuing in the same browser and will message you when it's done (or if she needs anything else)." : "She'll tell you where things stand."}</p><div class="row"><a class="btn alt" href="/chat">Back to chat</a></div>`));
  }

  // Start (or reuse) the browser they'll use, at the page where Kimi stopped.
  if (!(await sessionRunning(t.sessionId))) {
    t.sessionId = await openForHuman(t.url, 15);
    await saveTask(task);
  }
  const live = await liveViewUrl(t.sessionId!, 900);
  if (!live) return res.status(502).send(page("Couldn't open", `<h1>Couldn't open the browser</h1><p class="sub">Try the link again in a moment.</p>`));
  const form = (action: string, label: string, cls: string) => `<form method="post" action="/api/takeover" style="margin:0"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="action" value="${action}"><button class="${cls}">${label}</button></form>`;
  return res.status(200).send(
    page(
      "Take over",
      `<h1>Kimi needs a hand</h1>
<p class="sub">${esc(task.title)} — ${esc(t.reason)}. Solve it in the browser below, then tap <b>Done</b>. Kimi continues from exactly here.</p>
<iframe src="${esc(live)}" allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
<div class="row">${form("done", "Done — Kimi can continue", "go")}${form("cancel", "Skip this step", "alt")}<a class="btn lnk" href="${esc(live)}" target="_blank" rel="noreferrer">Open full screen ↗</a></div>`
    )
  );
}
