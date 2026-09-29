import { useState } from "react";
import type { Todo } from "../data/types";
import { dateLabel, daysUntil, fmtDate, isTodoUrgent, SOURCE_LABEL } from "../store";
import { WhoChips, Button, EditButton } from "./ui";
import { peopleOf, ownerOf } from "../data/people";

// One to-do row. The checkbox completes it; tapping the text expands it
// (read-only) with Mark done / Edit; the pencil jumps straight to editing.
export function TodoItem({
  todo,
  done,
  onToggle,
  onEdit,
  showDue = true,
}: {
  todo: Todo;
  done: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  /** Hide the due label when the surrounding section already says which day it is. */
  showDue?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const overdue = todo.due ? daysUntil(todo.due) < 0 && !done : false;
  const who = peopleOf(todo).length > 0 || ownerOf(todo).length > 0;

  return (
    <div>
      <div className="flex items-start gap-1 px-3 py-2">
        <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            checked={done}
            onChange={onToggle}
            aria-label={done ? `Reopen: ${todo.title}` : `Mark done: ${todo.title}`}
            className="h-5 w-5 rounded border-line accent-accent"
          />
        </label>
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-h-[44px] min-w-0 flex-1 items-start justify-between gap-3 py-1.5 text-left">
          <div className="min-w-0 flex-1">
            <div className={`break-words text-[15px] font-medium leading-snug ${done ? "text-ink-3 line-through" : "text-ink"}`}>
              {isTodoUrgent(todo) && !done && (
                <span className="mr-1.5 rounded bg-danger-soft px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-danger">
                  High
                </span>
              )}
              {todo.title}
            </div>
            {todo.detail && !done && !open && <div className="mt-0.5 line-clamp-1 break-words text-[13px] text-ink-3">{todo.detail}</div>}
            {who && !open && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                <WhoChips people={peopleOf(todo)} owner={ownerOf(todo)} />
              </div>
            )}
          </div>
          {todo.due && (showDue || overdue) && (
            <div className="shrink-0 text-right">
              <div className={`text-xs font-bold ${overdue ? "text-danger" : "text-accent"}`}>{overdue ? "Overdue" : dateLabel(todo.due)}</div>
              {overdue && <div className="text-[10px] text-danger">{dateLabel(todo.due)}</div>}
            </div>
          )}
        </button>
        {onEdit && <EditButton onClick={onEdit} label={`Edit ${todo.title}`} className="mt-0.5" />}
      </div>

      {open && (
        <div className="space-y-2 px-4 pb-3 pl-[3.25rem]">
          {todo.detail && <div className="whitespace-pre-line break-words text-sm text-ink-2">{todo.detail}</div>}
          <div className="text-xs text-ink-3">
            {todo.due ? `Due ${fmtDate(todo.due)}` : "No due date"}
            {todo.source ? ` · from ${SOURCE_LABEL[todo.source] || todo.source}` : ""}
          </div>
          {who && <WhoChips people={peopleOf(todo)} owner={ownerOf(todo)} />}
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={onToggle} className={done ? "" : "bg-ok active:bg-ok"} variant={done ? "secondary" : "primary"}>
              {done ? "Reopen" : "Mark done"}
            </Button>
            {onEdit && (
              <Button size="sm" variant="secondary" onClick={onEdit}>
                Edit
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
