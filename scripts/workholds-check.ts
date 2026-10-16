#!/usr/bin/env tsx
// Work-calendar holds: which family events get a "DNS – …" hold, and that a hold follows its event
// (placed, moved, taken down). Local: nothing reaches Google (sandbox) and writes stay in the overlay.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const db = await import("../api/_lib/db");
const { holdable, wantsNewHold, syncWorkHolds, setHoldPref, listHolds, holdTitle } = await import("../api/_lib/workholds");
const { wallToUtc } = await import("../src/data/tz");
import type { CalEvent } from "../src/data/types";
import type { WorkBlock } from "../api/_lib/workcal";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
if (!db.isOverlay) { console.error("refusing to run against live data (LIVE_DATA=1)"); process.exit(1); }

// A weekday a few weeks out.
const pt = (d: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + d * 86400000));
let D = pt(20);
while ([0, 6].includes(new Date(`${D}T12:00:00Z`).getUTCDay())) D = pt(Math.round((Date.parse(D) - Date.now()) / 86400000) + 2);
const ev = (start: string, end: string, x: Partial<CalEvent> = {}): CalEvent => ({ id: `evt-wh-${start}`, title: "Spring Fun Run", date: D, start, end, allDay: false, owner: ["alex", "sam"], travelMin: 15, ...x });
const at = (t: string) => wallToUtc(D, t, "America/Los_Angeles").toISOString();
const blk = (s: string, e: string, title: string, x: Partial<WorkBlock> = {}): WorkBlock => ({ start: at(s), end: at(e), allDay: false, title, outOfOffice: false, hold: false, travel: false, ...x });

check("a weekday morning event the parent is on gets a hold", holdable(ev("08:30", "09:30"), "alex", undefined));
check("a kids' event naming no parent counts (whoever goes)", holdable(ev("14:00", "14:30", { owner: [], people: ["kid1"] }), "alex", undefined, Date.now(), ["kid1"]));
check("…but not a guest's thing naming no parent (something for a guest)", !holdable(ev("14:00", "14:30", { owner: [], people: ["Visitor"] }), "alex", undefined, Date.now(), ["kid1"]));
check("not one they aren't on", !holdable(ev("08:30", "09:30", { owner: ["sam"] }), "alex", undefined));
check("…unless they ask", holdable(ev("08:30", "09:30", { owner: ["sam"] }), "alex", "yes"));
check("not after hours (a 6 PM dinner, even with the drive)", !holdable(ev("18:00", "21:00"), "alex", undefined));
check("a late-afternoon event that starts before 6 does", holdable(ev("17:00", "18:00"), "alex", undefined));
check("not a repeating event", !holdable(ev("08:10", "08:40", { seriesId: "s1" }), "alex", undefined));
check("not an all-day one", !holdable({ ...ev("08:00", "09:00"), allDay: true, start: undefined, end: undefined }, "alex", undefined));
check("not a long come-when-you-can one (10–5)", !holdable(ev("10:00", "17:00"), "alex", undefined));
check("not one they said not to hold", !holdable(ev("08:30", "09:30"), "alex", "no"));
check("not an invitation still waiting on a decision", !holdable(ev("08:30", "09:30", { invite: { status: "pending" } as any }), "alex", undefined));
check("not Sam's private event", !holdable(ev("08:30", "09:30", { privateTo: "sam" }), "alex", undefined));
check("the title says what it's for", holdTitle(ev("08:30", "09:30")) === "DNS – Spring Fun Run");

const e1 = ev("08:30", "09:30");
check("no new hold when a meeting already collides (that's a conflict text)", !wantsNewHold(e1, "alex", [blk("09:00", "09:30", "Partner call")]));
check("…or when they've already blocked the time themselves", !wantsNewHold(e1, "alex", [blk("08:15", "10:00", "DNS", { hold: true })]));
check("…but an office day alone doesn't stop it", wantsNewHold(e1, "alex", [blk("08:45", "09:30", "Travel", { hold: true, travel: true }), blk("16:00", "16:45", "Travel", { hold: true, travel: true })]));
check("Kimi's own hold isn't them blocking it", wantsNewHold(e1, "alex", [blk("08:15", "09:45", "DNS – Spring Fun Run", { hold: true, kimiHold: true })]));

// ── A hold follows its event ────────────────────────────────────────────────
const e = ev("08:30", "09:30", { id: `evt-wh-${Date.now().toString(36)}` });
await setHoldPref("alex", e.id, true); // whatever the real work day looks like
let r = await syncWorkHolds([e], { only: [e.id] });
check("placed", r.placed.length === 1 && (await listHolds("alex")).some((h) => h.eventId === e.id), r.placed.join("; "));
check("…padded by the drive", (await listHolds("alex")).find((h) => h.eventId === e.id)?.start === new Date(+new Date(at("08:30")) - 15 * 60000).toISOString());
r = await syncWorkHolds([e], { only: [e.id] });
check("nothing changes when nothing changed", !r.placed.length && !r.moved.length && !r.removed.length);
r = await syncWorkHolds([{ ...e, start: "13:00", end: "13:30" }], { only: [e.id] });
check("moved when the event moves", r.moved.length === 1 && (await listHolds("alex")).find((h) => h.eventId === e.id)?.start === new Date(+new Date(at("13:00")) - 15 * 60000).toISOString());
await setHoldPref("alex", e.id, false);
r = await syncWorkHolds([e], { only: [e.id] });
check("taken down when they say not to hold it", r.removed.length === 1 && !(await listHolds("alex")).some((h) => h.eventId === e.id));
await setHoldPref("alex", e.id, true);
await syncWorkHolds([e], { only: [e.id] });
r = await syncWorkHolds([], { only: [e.id] });
check("taken down when the event is gone", r.removed.length === 1);

await db.dropTestData();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
