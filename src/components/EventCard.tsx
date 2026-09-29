import { useState } from "react";
import { dateLabel, displayDate, eventTimeRange, fmtDate, SOURCE_LABEL } from "../store";
import { htmlToText } from "../data/text";
import { Card, WhoChips, Button, EditButton } from "./ui";
import { peopleOf, ownerOf } from "../data/people";
import { toHomeZone, fmt12 } from "../data/tz";
import type { CalEvent } from "../data/types";

/** "Leave by 11:15 AM" for a timed event a real drive from home (drive + 5 min buffer). */
function leaveBy(e: CalEvent): string | null {
  if (e.allDay || !e.travelMin || e.travelMin < 10 || e.travelMin > 180) return null;
  const start = toHomeZone(e).start;
  if (!start) return null;
  const t = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) - e.travelMin - 5;
  const m = ((t % 1440) + 1440) % 1440;
  return `~${e.travelMin} min drive · leave by ${fmt12(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`)}`;
}

// Consistent event card used on Home + Agenda. Tap to expand it (read-only:
// full notes, location, who, where it came from) with an Edit button; the
// pencil jumps straight to editing. Dates/times render in the home zone (PT).
export function EventCard({ e, onEdit, showDate = true }: { e: CalEvent; onEdit?: () => void; showDate?: boolean }) {
  const [open, setOpen] = useState(false);
  const timeStr = eventTimeRange(e);
  const notes = htmlToText(e.prep);
  const who = peopleOf(e).length > 0 || ownerOf(e).length > 0;
  const drive = leaveBy(e);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 py-3 pl-4 pr-1 text-left">
          <div className="break-words text-[15px] font-semibold leading-snug text-ink">{e.title}</div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[13px] text-ink-3">
            {showDate && <span className="shrink-0 font-semibold text-accent">{dateLabel(displayDate(e))}</span>}
            {timeStr && <span className="shrink-0">{timeStr}</span>}
            {e.location && !open && (
              <span className="min-w-0 truncate">
                {(showDate || timeStr) && "· "}
                {e.location.split(",")[0]}
              </span>
            )}
          </div>
          {drive && !open && <div className="mt-0.5 text-[12px] text-ink-3">🚗 {drive}</div>}
          {notes && !open && <div className="mt-1 line-clamp-1 break-words text-[13px] text-ink-2">{notes}</div>}
          {who && !open && (
            <div className="mt-2 flex flex-wrap gap-1">
              <WhoChips people={peopleOf(e)} owner={ownerOf(e)} />
            </div>
          )}
        </button>
        {onEdit && <EditButton onClick={onEdit} label={`Edit ${e.title}`} className="mr-1 mt-1.5" />}
      </div>

      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          <Row label="When">
            {fmtDate(displayDate(e))}
            {timeStr ? ` · ${timeStr}` : ""}
          </Row>
          {e.location && (
            <Row label="Where">
              {e.location}
              {drive && <div className="text-ink-3">🚗 {drive}</div>}
            </Row>
          )}
          {notes && (
            <Row label="Notes">
              <span className="whitespace-pre-line">{notes}</span>
            </Row>
          )}
          {who && (
            <Row label="Who">
              <WhoChips people={peopleOf(e)} owner={ownerOf(e)} />
            </Row>
          )}
          <Row label="Source">
            {e.source ? SOURCE_LABEL[e.source] || e.source : "Added by hand"}
            {e.gcalId ? " · on Google Calendar" : ""}
          </Row>
          {onEdit && (
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="secondary" onClick={onEdit}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-14 shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-3 pt-0.5">{label}</span>
      <span className="min-w-0 break-words text-ink">{children}</span>
    </div>
  );
}
