#!/usr/bin/env tsx
// Unit checks for scheduled/recurring task dates (api/_lib/schedules.ts). No network, no writes.
import { nextDate, computeNextRun, describe } from "../api/_lib/schedules";
import type { Repeat } from "../src/data/types";
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`);
};
const seq = (r: Repeat, anchor: string, n: number) => {
  const out: string[] = [];
  let d: string | null = nextDate(r, anchor, anchor, true);
  while (d && out.length < n) { out.push(d); d = nextDate(r, anchor, d); }
  return out;
};
eq("last day of month (incl. Feb, leap 2028)", seq({ freq: "monthly", monthDay: -1 }, "2026-09-30", 6), ["2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
eq("leap Feb", nextDate({ freq: "monthly", monthDay: -1 }, "2028-01-31", "2028-01-31"), "2028-02-29");
eq("31st clamps to 30th/28th", seq({ freq: "monthly", monthDay: 31 }, "2026-10-31", 5), ["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
eq("first Tuesday", seq({ freq: "monthly", nth: { n: 1, weekday: 2 } }, "2026-10-06", 3), ["2026-10-06", "2026-11-03", "2026-12-01"]);
eq("last Friday", seq({ freq: "monthly", nth: { n: -1, weekday: 5 } }, "2026-10-30", 3), ["2026-10-30", "2026-11-27", "2026-12-25"]);
eq("every other week Tue+Thu", seq({ freq: "weekly", interval: 2, weekdays: [2, 4] }, "2026-09-29", 5), ["2026-09-29", "2026-10-01", "2026-10-13", "2026-10-15", "2026-10-27"]);
eq("weekdays", seq({ freq: "weekly", weekdays: [1, 2, 3, 4, 5] }, "2026-10-02", 4), ["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]);
eq("every 3 days", seq({ freq: "daily", interval: 3 }, "2026-09-28", 3), ["2026-09-28", "2026-10-01", "2026-10-04"]);
eq("quarterly (every 3 months on the 1st)", seq({ freq: "monthly", interval: 3, monthDay: 1 }, "2026-10-01", 3), ["2026-10-01", "2027-01-01", "2027-04-01"]);
eq("yearly Feb 29 → Feb 28", seq({ freq: "yearly" }, "2028-02-29", 2), ["2028-02-29", "2029-02-28"]);
eq("until stops", seq({ freq: "weekly", until: "2026-10-13" }, "2026-09-29", 9), ["2026-09-29", "2026-10-06", "2026-10-13"]);
// computeNextRun in home time (Pacific): 9 AM PDT = 16:00Z; after DST ends (Nov 1) 9 AM PST = 17:00Z
eq("next run later today", computeNextRun({ anchor: "2026-09-28", time: "09:00", repeat: { freq: "daily" } }, "2026-09-28T15:00:00Z"), "2026-09-28T16:00:00.000Z");
eq("next run skips passed time", computeNextRun({ anchor: "2026-09-28", time: "09:00", repeat: { freq: "daily" } }, "2026-09-28T16:00:00.000Z"), "2026-09-29T16:00:00.000Z");
eq("DST: 9 AM stays 9 AM", computeNextRun({ anchor: "2026-10-31", time: "09:00", repeat: { freq: "monthly", monthDay: -1 } }, "2026-10-31T17:00:00Z"), "2026-11-30T17:00:00.000Z");
eq("one-time future", computeNextRun({ anchor: "2026-10-06", time: "08:00" }, "2026-09-28T15:00:00Z"), "2026-10-06T15:00:00.000Z");
eq("one-time past → null", computeNextRun({ anchor: "2026-09-01", time: "08:00" }, "2026-09-28T15:00:00Z"), null);
eq("describe last day", describe({ anchor: "2026-09-30", time: "09:00", repeat: { freq: "monthly", monthDay: -1 } }), "Every month on the last day at 9:00 AM");
eq("describe biweekly", describe({ anchor: "2026-09-29", time: "18:30", repeat: { freq: "weekly", interval: 2, weekdays: [2, 4] } }), "Every 2 weeks on Tue, Thu at 6:30 PM");
eq("describe first Tuesday", describe({ anchor: "2026-10-06", time: "08:00", repeat: { freq: "monthly", nth: { n: 1, weekday: 2 } } }), "Every month on the first Tuesday at 8:00 AM");
eq("describe once", describe({ anchor: "2026-10-06", time: "08:00" }), "Once, Tue, Oct 6 at 8:00 AM");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
