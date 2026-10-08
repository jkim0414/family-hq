import { randomBytes } from "node:crypto";
import { getCollection, setCollection, addAudit, getTask, saveTask, redis, appendItems, trimCollection } from "./db.js";
import { sendEmail } from "./email.js";
import { userById } from "./auth.js";
import type { Action, ActionKind, EmailPayload, StepPayload, Channel, Member } from "../../src/data/types";
import { canSeeArtifact } from "./privacy.js";

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
  privateTo?: Member;
  /** A caregiver who asked for this: she sees its status; a parent decides. */
  requester?: Member;
  /** Who it's visible to (a shared chat's members, plus the parents for a caregiver's request). */
  audience?: Member[];
  /** The chat it came from. */
  thread?: string;
}): Promise<Action> {
  const action: Action = {
    id: `act-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
    status: "proposed",
    createdAt: new Date().toISOString(),
    ...input,
  };
  // The page screenshot (~150 KB) is stored on its own, not in the approvals list every load reads.
  const shot = (action.payload as StepPayload).screenshot;
  if (shot) {
    await redis.set(shotKey(action.id), shot, { ex: SHOT_TTL });
    const { screenshot: _s, ...rest } = action.payload as StepPayload;
    action.payload = { ...rest, hasScreenshot: true };
  }
  await appendItems("actions", [action]);
  await trimCollection("actions", 200);
  await addAudit({ kind: "proposed", summary: `${action.title} — awaiting approval`, by: "agent", ref: action.id, privateTo: action.privateTo, audience: action.audience });
  return action;
}

const SHOT_TTL = 60 * 86400;
const shotKey = (id: string) => `action_shot:${id}`;

/** An approval's page screenshot (base64 JPEG), if it has one. */
export async function actionScreenshot(a: Action): Promise<string | null> {
  return (await redis.get<string>(shotKey(a.id))) ?? (a.payload as StepPayload).screenshot ?? null;
}

/**
 * Approvals waiting on this parent, newest first (shared ones, or their own private ones). With a
 * thread: only that chat's (a group text approves only what was asked in that group).
 */
export async function pendingFor(who: Member, thread?: string): Promise<Action[]> {
  const actions = await getCollection("actions");
  return [...actions].reverse().filter((a) => a.status === "proposed" && canSeeArtifact(a, who) && (!thread || a.thread === thread));
}

/** The newest approval waiting on this parent. */
export async function latestPending(who?: Member): Promise<Action | null> {
  const actions = await getCollection("actions");
  return [...actions].reverse().find((a) => a.status === "proposed" && (!who || canSeeArtifact(a, who))) || null;
}

/** A short code for naming one approval in a text ("APPROVE 4821"). */
export function approvalCode(a: { id: string }): string {
  let h = 0;
  for (const ch of a.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(1000 + (h % 9000));
}

/**
 * Which approval a texted APPROVE/DECLINE means: the only one waiting, or the one whose code it
 * names. Several waiting and no code: ask which (never guess — the newest isn't always the one
 * they were looking at).
 */
export function pickPending(pending: Action[], code: string | undefined): { action?: Action; ask?: string } {
  if (!pending.length) return { ask: "Nothing is waiting for approval right now." };
  if (code) {
    const a = pending.find((x) => approvalCode(x) === code);
    return a ? { action: a } : { ask: `No approval with code ${code} is waiting.` };
  }
  if (pending.length === 1) return { action: pending[0] };
  const list = pending.slice(0, 5).map((a) => `${approvalCode(a)}: ${a.title.slice(0, 80)}`).join("\n");
  return { ask: `${pending.length} things are waiting. Reply APPROVE or DECLINE with the code:\n${list}` };
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
  // One decision per approval, even when the app and a text arrive at once.
  if (!(await redis.set(`action_lock:${id}`, by, { nx: true, ex: 120 }))) throw new Error("action already being decided");
  const actions = await getCollection("actions");
  const a = actions.find((x) => x.id === id);
  if (!a) throw new Error("action not found");
  if (a.status !== "proposed") throw new Error(`action already ${a.status}`);
  if (!canSeeArtifact(a, by)) throw new Error("action not found"); // someone else's (private, or another chat's)
  a.decidedAt = new Date().toISOString();
  a.decidedBy = by;
  if (decision === "decline") {
    a.status = "declined";
    await setCollection("actions", actions);
    await addAudit({ kind: "declined", summary: a.title, by, ref: a.id, privateTo: a.privateTo, audience: a.audience });
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
    await addAudit({ kind: "executed", summary: `${a.title} — ${a.result}`, by, ref: a.id, privateTo: a.privateTo, audience: a.audience });
  } catch (e) {
    a.status = "failed";
    a.error = String(e);
    await setCollection("actions", actions);
    await addAudit({ kind: "failed", summary: `${a.title} — ${a.error}`, by, ref: a.id, privateTo: a.privateTo, audience: a.audience });
  }
  return a;
}
