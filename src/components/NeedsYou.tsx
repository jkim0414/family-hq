import { useState } from "react";
import { useData } from "../dataStore";
import { todayISO } from "../store";
import { urgentTodos } from "../agenda";
import { Card, Button, TextAction } from "./ui";
import { TodoEditor } from "./editors";
import { TodoItem } from "./TodoItem";
import type { Action, EmailPayload, StepPayload, Suggestion, Todo } from "../data/types";

// Everything that's waiting on a parent, one row each, approvals first:
// browser-task steps and emails to approve, suggested calendar/roster changes
// to confirm, and to-dos that are overdue or due within ~48h. Severity is
// carried by position and color, never by size.

type Row = { kind: "action"; a: Action } | { kind: "suggestion"; s: Suggestion } | { kind: "todo"; t: Todo };

const SHOW = 5;

export function needsYouCount(actions: Action[] | undefined, suggestions: Suggestion[] | undefined, todos: Todo[]): number {
  const today = todayISO();
  return (
    (actions || []).filter((a) => a.status === "proposed").length +
    (suggestions || []).filter((s) => !s.notBefore || s.notBefore <= today).length +
    urgentTodos(todos).length
  );
}

export function NeedsYou() {
  const { data, decideAction, suggestion, toggleTodo } = useData();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editTodo, setEditTodo] = useState<Todo | null>(null);

  const today = todayISO();
  const rows: Row[] = [
    ...(data.actions || []).filter((a) => a.status === "proposed").map((a): Row => ({ kind: "action", a })),
    ...data.suggestions.filter((s) => !s.notBefore || s.notBefore <= today).map((s): Row => ({ kind: "suggestion", s })),
    ...urgentTodos(data.todos).map((t): Row => ({ kind: "todo", t })),
  ];

  if (!rows.length)
    return (
      <div className="flex items-center gap-2 px-1 text-[15px] text-ink-3">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ok-soft text-[11px] text-ok">✓</span>
        All clear — nothing needs you right now.
      </div>
    );

  const shown = all ? rows : rows.slice(0, SHOW);
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card className="divide-y divide-line border-l-4 border-l-danger">
        {shown.map((row) => {
          if (row.kind === "todo") {
            const t = row.t;
            return <TodoItem key={t.id} todo={t} done={false} onToggle={() => toggleTodo(t.id, true)} onEdit={() => setEditTodo(t)} />;
          }

          if (row.kind === "suggestion") {
            const s = row.s;
            return (
              <div key={s.id} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 shrink-0 text-base leading-none">💡</span>
                <div className="min-w-0 flex-1">
                  <div className="break-words text-sm text-ink">{s.description}</div>
                  <div className="mt-1.5 flex gap-2">
                    <Button size="sm" disabled={busy === s.id} onClick={() => run(s.id, () => suggestion(s.id, "apply"))}>
                      Apply
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => run(s.id, () => suggestion(s.id, "dismiss"))}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              </div>
            );
          }

          const a = row.a;
          const isEmail = a.kind === "send_email";
          const email = isEmail ? (a.payload as EmailPayload) : null;
          const step = !isEmail ? (a.payload as StepPayload) : null;
          const expanded = open === a.id;
          return (
            <div key={a.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 shrink-0 text-base leading-none">{isEmail ? "✉️" : "🖥️"}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{isEmail ? "Email to send" : "Browser task step"}</div>
                <div className="break-words text-sm font-medium text-ink">{isEmail ? a.title : step!.description}</div>
                {email && (
                  <div className="mt-0.5 break-words text-xs text-ink-3">
                    To: {email.to.join(", ")}
                    {email.cc?.length ? ` · Cc: ${email.cc.join(", ")}` : ""}
                  </div>
                )}
                {step?.url && <div className="mt-0.5 truncate text-xs text-ink-3">{step.url}</div>}
                {(email || step?.hasScreenshot || step?.screenshot) && (
                  <TextAction className="-ml-2 mt-0.5" onClick={() => setOpen(expanded ? null : a.id)}>
                    {expanded ? "Hide" : email ? "Read the draft" : "See the page"}
                  </TextAction>
                )}
                {expanded && email && (
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-fill p-2 font-sans text-xs text-ink-2">
                    <b>Subject:</b> {email.subject}
                    {"\n\n"}
                    {email.body}
                  </pre>
                )}
                {expanded && (step?.hasScreenshot || step?.screenshot) && <img src={`/api/action?id=${a.id}&shot=1`} alt="Page the task is on" className="mt-1 w-full rounded-lg ring-1 ring-line" />}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" disabled={busy === a.id} onClick={() => run(a.id, () => decideAction(a.id, "approve"))} className="bg-ok active:bg-ok">
                    {isEmail ? "Approve & send" : "Approve"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => run(a.id, () => decideAction(a.id, "decline"))}>
                    Decline
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {rows.length > SHOW && (
          <div className="px-4 py-2 text-center">
            <TextAction onClick={() => setAll((s) => !s)}>{all ? "Show fewer" : `${rows.length - SHOW} more`}</TextAction>
          </div>
        )}
      </Card>
      {editTodo && <TodoEditor todo={editTodo} onClose={() => setEditTodo(null)} />}
    </>
  );
}
