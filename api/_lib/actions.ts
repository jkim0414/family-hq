import { randomBytes } from "node:crypto";
import { getCollection, setCollection, addAudit, getTask, saveTask } from "./db.js";
import { sendEmail } from "./email.js";
import { userById } from "./auth.js";
import type { Action, ActionKind, EmailPayload, StepPayload, Channel } from "../../src/data/types";

// One approval covers the whole job — long enough to finish even across cron ticks.
const APPROVAL_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Wake a paused browser task with the parent's decision. */
async function pokeTask(taskId: string, text: string, granted: boolean): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  (task.thread as unknown[]).push({ role: "user", content: `[system · approval]\n${text}` });
  task.log.push({ at: new Date().toISOString(), kind: "system", text });
  task.waitingOn = undefined;
  task.approvedUntil = granted ? new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString() : undefined;
  task.status = "running";
  task.nextCheckAt = new Date().toISOString();
  await saveTask(task);
}

// ─────────────────────────────────────────────────────────────────────────────
// Approve-by-default. The agent never acts on the outside world directly: it
// proposes an Action, a parent approves (Approvals card in the app, or "APPROVE"
// over SMS), and only then does it execute. Everything is audited.
// ─────────────────────────────────────────────────────────────────────────────

export async function proposeAction(input: {
  kind: ActionKind;
  title: string;
  summary: string;
  payload: EmailPayload | StepPayload;
  taskId?: string;
  requestedBy: Action["requestedBy"];
  channel: Channel;
  /** Private to one parent (proposed from their "Just me" thread). */
  privateTo?: "alex" | "sam";
}): Promise<Action> {
  const action: Action = {
    id: `act-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
    status: "proposed",
    createdAt: new Date().toISOString(),
    ...input,
  };
  const actions = await getCollection("actions");
  actions.push(action);
  await setCollection("actions", actions.slice(-200));
  await addAudit({ kind: "proposed", summary: `${action.title} — awaiting approval`, by: "agent", ref: action.id, privateTo: action.privateTo });
  return action;
}

/** The newest approval waiting on this parent (shared ones, or their own private ones). */
export async function latestPending(who?: "alex" | "sam"): Promise<Action | null> {
  const actions = await getCollection("actions");
  return [...actions].reverse().find((a) => a.status === "proposed" && (!who || !a.privateTo || a.privateTo === who)) || null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function perform(action: Action, by: "alex" | "sam"): Promise<string> {
  switch (action.kind) {
    case "confirm_step": {
      const p = action.payload as StepPayload;
      await pokeTask(p.taskId, `Approval GRANTED by ${by} for: ${p.description}\nYou have 10 minutes to perform exactly that step. Then continue the task.`, true);
      return "Approved — the task is continuing";
    }
    case "send_email": {
      const p = action.payload as EmailPayload;
      const parent = userById(by);
      const html = `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap">${esc(p.body)}</div>`;
      await sendEmail(p.subject, html, {
        to: p.to,
        cc: p.cc,
        text: p.body,
        replyTo: parent?.email,
        fromName: `${parent?.name || "A parent"} (via Family HQ)`,
      });
      return `Sent to ${p.to.join(", ")}`;
    }
    default:
      throw new Error(`unknown action kind ${(action as Action).kind}`);
  }
}

export async function decideAction(id: string, decision: "approve" | "decline", by: "alex" | "sam"): Promise<Action> {
  const actions = await getCollection("actions");
  const a = actions.find((x) => x.id === id);
  if (!a) throw new Error("action not found");
  if (a.status !== "proposed") throw new Error(`action already ${a.status}`);
  if (a.privateTo && a.privateTo !== by) throw new Error("action not found"); // someone else's private approval
  a.decidedAt = new Date().toISOString();
  a.decidedBy = by;
  if (decision === "decline") {
    a.status = "declined";
    await setCollection("actions", actions);
    await addAudit({ kind: "declined", summary: a.title, by, ref: a.id, privateTo: a.privateTo });
    if (a.kind === "confirm_step") {
      const p = a.payload as StepPayload;
      await pokeTask(p.taskId, `Approval DECLINED by ${by} for: ${p.description}\nDo NOT perform it. Wrap up: report what was done so far and what's pending.`, false);
    }
    return a;
  }
  try {
    a.result = await perform(a, by);
    a.status = "executed";
    a.executedAt = new Date().toISOString();
    await setCollection("actions", actions);
    await addAudit({ kind: "executed", summary: `${a.title} — ${a.result}`, by, ref: a.id, privateTo: a.privateTo });
  } catch (e) {
    a.status = "failed";
    a.error = String(e);
    await setCollection("actions", actions);
    await addAudit({ kind: "failed", summary: `${a.title} — ${a.error}`, by, ref: a.id, privateTo: a.privateTo });
  }
  return a;
}
