#!/usr/bin/env tsx
// Time-sensitive mail goes by text, after Kimi checks each is still open: an action due soon is
// texted; a confirmation of something already done isn't. Local: overlay writes, nothing sent.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const db = await import("../api/_lib/db");
const { queueAlerts, pendingAlerts } = await import("../api/_lib/alerts");
const a = await import("../api/_lib/agent");

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
if (!db.isOverlay) { console.error("refusing to run against live data (LIVE_DATA=1)"); process.exit(1); }

const tag = `al${Date.now().toString(36)}`;
const tomorrow = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "short", day: "numeric" }).format(new Date(Date.now() + 86400000));
await queueAlerts([
  { commId: `comm-${tag}-slip`, title: "Field trip permission slip due tomorrow", summary: `The signed permission slip for the aquarium field trip is due ${tomorrow}; sign online at https://forms.example.org/aquarium-slip.`, owner: ["alex", "sam"], at: new Date().toISOString() },
  { commId: `comm-${tag}-conf`, title: "You're signed up: bake sale table", summary: "Confirmation: you are signed up to help at the bake sale next week. No further action needed.", owner: ["alex", "sam"], at: new Date().toISOString() },
]);
const r = await a.runAlerts(Date.now() + 200_000, { thread: `task-journey-alerts-${tag}`, send: false, only: [`comm-${tag}-slip`, `comm-${tag}-conf`] });
console.log(`\nKimi:\n${r.text}\n`);
const t = (r.text || "").toLowerCase();
check("both were handled", r.handled === 2);
check("the action due tomorrow is texted, with the step", /permission slip/.test(t) && /forms\.example\.org|sign/.test(t));
check("the confirmation isn't presented as something to do", !/bake sale/.test(t) || /signed up|already|confirm/.test(t));
check("nothing left in the queue", !(await pendingAlerts()).some((x) => x.commId.includes(tag)));

await db.dropTestData();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
