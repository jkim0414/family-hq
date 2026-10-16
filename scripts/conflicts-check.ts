#!/usr/bin/env tsx
// Work conflicts: a family event that collides with a parent's work day is raised once, with the
// specifics and a recommendation. The rules run on made-up work days; then a real upcoming event
// (the first one found that collides) against the real work calendars, with Kimi writing the text in
// a throwaway chat. Local runs write only to the overlay and send nothing. One model turn.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const db = await import("../api/_lib/db");
const { clashesFor, plannedFor, responsibleFor, findConflicts } = await import("../api/_lib/conflicts");
const a = await import("../api/_lib/agent");
const { wallToUtc } = await import("../src/data/tz");
import type { CalEvent } from "../src/data/types";
import type { WorkBlock } from "../api/_lib/workcal";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
if (!db.isOverlay) { console.error("refusing to run against live data (LIVE_DATA=1)"); process.exit(1); }

// ── The rules, on a made-up Wednesday ────────────────────────────────────────
const D = "2031-03-12"; // a Wednesday, far from anything real
const at = (t: string) => wallToUtc(D, t, "America/Los_Angeles").toISOString();
const blk = (s: string, e: string, title: string, x: Partial<WorkBlock> = {}): WorkBlock => ({ start: at(s), end: at(e), allDay: false, title, outOfOffice: false, hold: false, travel: false, ...x });
const ev = (start: string, end: string, x: Partial<CalEvent> = {}): CalEvent => ({ id: "evt-cc", title: "Spring Fun Run", date: D, start, end, allDay: false, owner: ["alex", "sam"], travelMin: 15, ...x });
const officeDay = [
  blk("08:15", "08:45", "Dropoff", { hold: true }),
  blk("08:45", "09:30", "Travel", { hold: true, travel: true }),
  blk("10:00", "10:30", "Partner call", { video: true }),
  blk("10:30", "11:15", "Coffee meet", { location: "a café downtown" }),
  blk("16:00", "16:45", "Travel", { hold: true, travel: true }),
];
const morning = clashesFor(ev("07:30", "10:30"), "alex", officeDay);
check("a morning event on an office day: the call, the coffee right after, and the office day", ["meeting", "meeting", "office"].every((k, i) => morning.map((c) => c.kind).sort()[i] === k) && morning.some((c) => /Coffee meet/.test(c.line) && /café downtown/.test(c.line)), morning.map((c) => c.line).join(" | "));
check("holds (dropoff) aren't conflicts", !morning.some((c) => /Dropoff/.test(c.line)));
check("an evening event after the commute home isn't an office-day conflict", clashesFor(ev("17:00", "18:00"), "alex", officeDay).length === 0);
check("one morning commute alone doesn't make the evening busy", clashesFor(ev("16:30", "17:30"), "sam", [blk("07:30", "08:00", "Travel", { hold: true, travel: true })]).length === 0);
check("an entry Kimi can't place (maybe a hold) isn't a conflict on its own", clashesFor(ev("16:30", "17:30"), "sam", [blk("16:30", "17:15", "DNS", { unsure: true })]).length === 0);
check("a long come-when-you-can event isn't ruled out by a meeting", clashesFor(ev("14:00", "21:00"), "alex", [blk("14:00", "15:00", "Board prep")]).length === 0);
check("…but being out of office is", clashesFor(ev("14:00", "21:00"), "alex", [{ ...blk("00:00", "00:00", "OOO — conference", { outOfOffice: true }), allDay: true, start: `${D}T00:00:00`, end: "2031-03-13T00:00:00" }]).some((c) => c.kind === "out"));
const sam = [blk("08:00", "08:40", "Morning check-in", { hold: true }), blk("08:40", "09:10", "Fun Run (volunteer)", { hold: true }), blk("09:00", "10:30", "Team meeting")];
check("a parent who put the event on their work calendar has planned for it", !!plannedFor(ev("07:30", "10:30"), sam));
check("an event with no parent named is for whoever takes it", responsibleFor(ev("07:30", "10:30", { owner: [] })).anyOne && !responsibleFor(ev("07:30", "10:30")).anyOne);
check("a private event is only for its owner", responsibleFor(ev("07:30", "10:30", { privateTo: "alex" })).parents.join() === "alex");

// ── A real upcoming event against the real work calendars ───────────────────
const events = await db.getCollection("events");
await db.redis.del("conflicts_seen"); // the overlay's copy only: as if nothing had been raised yet
const first = await findConflicts(events);
const flag = first.flags[0];
if (!flag) {
  console.log("(no upcoming family event collides with a work calendar right now — skipping the live part)");
} else {
  console.log(`\nLive: ${flag.event.title} ${flag.event.date} ${flag.event.start} — ${flag.clashes.map((c) => c.line).join(" | ")}`);
  check("the conflict names what collides", flag.clashes.length > 0 && flag.context.length > 0);
  check("a meeting's video link isn't spelled out (no passcodes in texts)", !/https?:\/\//.test(flag.clashes.map((c) => c.line).join(" ") + flag.context));
  const chat = `task-journey-conflicts-${Date.now().toString(36)}`;
  const r = await a.runConflictFlags(Date.now() + 200_000, { thread: chat, only: [flag.event.id], send: false });
  console.log(`\nKimi:\n${r.text}\n`);
  const text = r.text || "";
  check("Kimi writes a text", r.flagged === 1 && text.length > 40);
  const named = flag.clashes.filter((c) => c.kind === "meeting").map((c) => c.line.match(/"([^"]+)"/)?.[1] || "").filter(Boolean);
  const words = (s: string) => (s.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 2);
  check("…naming the specific collision", named.length === 0 || named.some((n) => words(n).some((w) => text.toLowerCase().includes(w))), named.join("; "));
  check("…with a recommendation", /\b(recommend|suggest|could|move|reschedul|join|remote|video|zoom|from home|wfh|swap|skip|late|leave early|take)\b/i.test(text));
  const again = await a.runConflictFlags(Date.now() + 200_000, { thread: chat, only: [flag.event.id], send: false });
  check("raised once: the next run says nothing", again.flagged === 0 && !again.text);
  // The other way: a meeting booked onto a work calendar over an event already checked (by someone
  // who can't see the family calendar). Pretend the seen-record predates one of the meetings.
  const meeting = flag.clashes.find((c) => c.kind === "meeting");
  if (meeting) {
    const seenId = flag.seenId;
    const rec: any = await db.redis.hget("conflicts_seen", seenId);
    await db.redis.hset("conflicts_seen", { [seenId]: { ...rec, keys: rec.keys.filter((k: string) => k !== meeting.key) } });
    const nw = (await findConflicts(events, { only: [flag.event.id] })).flags[0];
    check("a meeting new on a work calendar over a checked event is raised", nw?.why === "new-work" && nw.fresh.length === 1 && nw.fresh[0].key === meeting.key);
    check("…to that parent alone", !!nw && nw.to.join() === meeting.parent, nw?.to.join());
    const t = await a.runConflictFlags(Date.now() + 200_000, { thread: `${chat}-nw`, only: [flag.event.id], send: false });
    console.log(`\nKimi (new on the work calendar):\n${t.text}\n`);
    const mname = meeting.line.match(/"([^"]+)"/)?.[1] || "";
    check("…naming the new meeting and what to do about it (move it / a note to forward)", (mname.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 2).some((w) => (t.text || "").toLowerCase().includes(w)) && /\b(move|reschedul|note|forward|ask)\w*/i.test(t.text || ""));
  }

  // Several at once: every one is raised, including one where the other parent is free.
  const all = first.flags.filter((f) => f.event.id !== flag.event.id).slice(0, 3);
  if (all.length) {
    const many = await a.runConflictFlags(Date.now() + 200_000, { thread: `${chat}-many`, only: all.map((f) => f.event.id), send: false });
    console.log(`\nKimi (${all.length} at once):\n${many.text}\n`);
    const t = (many.text || "").toLowerCase();
    const missing = all.filter((f) => !(f.event.title.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !["2026", "with", "from", "game"].includes(w)).slice(0, 3).some((w) => t.includes(w)));
    check("several conflicts at once: every one is raised", missing.length === 0, missing.map((f) => f.event.title).join("; "));
  }
  const moved = events.map((e) => (e.id === flag.event.id ? { ...e, start: flag.event.start, end: flag.event.end, owner: [...(e.owner || []), "x"] } : e));
  check("a change to the event (its time or who it's for) brings it up again", (await findConflicts(moved, { only: [flag.event.id] })).flags.length === 1);
}

await db.dropTestData();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
