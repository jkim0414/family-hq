#!/usr/bin/env tsx
// Invitations, decide first: a party invitation filed from email waits as a decision (not on the
// calendar, no "RSVP" to-do, its prep held), Kimi asks about it in one text, a parent's "yes" puts
// it on the calendar with its prep to-dos and an RSVP offer, and the morning text lists what's
// waiting. Runs in the local sandbox (nothing reaches anyone or Google) in a throwaway chat, and
// removes what it made. A few cents of model use.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const db = await import("../api/_lib/db");
const a = await import("../api/_lib/agent");
const { fileMessages } = await import("../api/_lib/file-mail");

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
const tag = `ic${Date.now().toString(36)}`;
const pt = (d: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + d * 86400000));
const partyDay = pt(2), rsvpBy = pt(1), laterDay = pt(12);
const chat = `task-journey-invites-${tag}`;
const key = `test-${tag}`;
// What existed before: anything new afterwards that Kimi made in the test chat (an add_todo she
// chose on her own) goes too.
const before = {
  events: new Set((await db.getCollection("events")).map((x: any) => x.id)),
  todos: new Set((await db.getCollection("todos")).map((x: any) => x.id)),
  schedules: new Set((await db.getCollection("schedules")).map((x: any) => x.id)),
  actions: new Set((await db.getCollection("actions")).map((x: any) => x.id)),
};
const madeHere = (x: any) => /^(todo|evt)-chat-|^sch-|^act-/.test(String(x.id)) || JSON.stringify(x).includes(tag) || /maya nguyen/i.test(JSON.stringify(x));
try {
  // 1) Filing: an invitation is a decision, not a calendar entry.
  await fileMessages([
    { key, mailbox: "school", uid: 0, date: new Date().toISOString(), from: "Pat Nguyen <pat.nguyen@example.com>", subject: `Maya's 6th birthday party ${tag}!`, attachments: [],
      text: `Hi! Maya is turning 6 and we'd love for Max and Theo (and the whole fam) to join us ${partyDay} from 2-4pm at Riverside Park. Please RSVP by ${rsvpBy} at https://www.evite.com/event/${tag}. Can't wait!` },
    { key: `${key}-b`, mailbox: "school", uid: 0, date: new Date().toISOString(), from: "PTA <pta@example.com>", subject: `Fall family movie night ${tag}`, attachments: [],
      text: `Join us for family movie night on ${laterDay} at 6pm in the school courtyard. Bring blankets! Optional, all families welcome.` },
  ] as any, { quiet: true });
  const filed = (await db.getCollection("events")).filter((e: any) => e.commId?.includes(tag));
  const party = filed.find((e: any) => /maya/i.test(e.title)) as any;
  const movie = filed.find((e: any) => /movie/i.test(e.title)) as any;
  check("the party is filed as an invitation, waiting on a decision", party?.invite?.status === "pending", JSON.stringify(party?.invite || null).slice(0, 160));
  check("…with its RSVP deadline and link", party?.invite?.rsvpBy === rsvpBy && /evite/.test(party?.invite?.rsvp || ""));
  check("…its prep held until a yes", (party?.invite?.heldTodos || []).some((t: any) => /gift/i.test(t.title)), (party?.invite?.heldTodos || []).map((t: any) => t.title).join("; "));
  const todosNow = (await db.getCollection("todos")).filter((t: any) => t.commId?.includes(tag));
  check("…and no RSVP / decide / prep to-dos yet", todosNow.length === 0, todosNow.map((t: any) => t.title).join("; "));
  check("…and not on the calendar (hidden from the app's calendar)", !!party && party.invite.status !== "yes" && !party.gcalId);
  check("the optional movie night is an invitation too", movie?.invite?.status === "pending");

  // 2) Asking: soon → asked right away, one text.
  const t: any = a.newTask(chat, "(check) invitations", "alex", "group");
  t.members = ["alex", "sam"];
  await db.saveTask(t);
  const ask = await a.runInvitationsAndRoundup(Date.now() + 150_000, { force: "ask", send: false, thread: chat, only: filed.map((e: any) => e.id) });
  check("the soon party is asked about right away", ask.asked === 1 && /maya/i.test(ask.text || ""), (ask.text || "").replace(/\s+/g, " ").slice(0, 200));
  check("…the movie night (12 days out) waits for the morning text", !/movie/i.test(ask.text || ""));

  // 3) A parent answers by text: yes for the boys.
  const r = await a.converse(chat, "sam", "group", "Yes! Max and Theo will go, I'll take them.", Date.now() + 150_000);
  const after = (await db.getCollection("events")).find((e: any) => e.id === party.id) as any;
  const madeTodos = (await db.getCollection("todos")).filter((x: any) => x.commId?.includes(tag));
  check("Sam's yes is recorded", after?.invite?.status === "yes", JSON.stringify(after?.invite?.going || []));
  check("…its prep to-dos are created", madeTodos.some((x: any) => /gift/i.test(x.title)), madeTodos.map((x: any) => x.title).join("; "));
  check("…and Kimi offers to RSVP", /rsvp/i.test(r.reply || ""), String(r.reply || "").replace(/\s+/g, " ").slice(0, 220));

  // 4) The morning text lists what's still waiting.
  const morning = await a.runInvitationsAndRoundup(Date.now() + 150_000, { force: "roundup", send: false, thread: chat, only: [movie.id] });
  check("the morning text asks about the movie night", /movie/i.test(morning.text || ""), (morning.text || "").replace(/\s+/g, " ").slice(0, 220));
} finally {
  const fresh = async (c: "events" | "todos" | "schedules" | "actions") => (await db.getCollection(c)).filter((x: any) => !before[c].has(x.id) && madeHere(x)).map((x: any) => x.id);
  const evs = [...new Set([...(await db.getCollection("events")).filter((e: any) => e.commId?.includes(tag)).map((e: any) => e.id), ...(await fresh("events"))])];
  const tds = [...new Set([...(await db.getCollection("todos")).filter((t: any) => t.commId?.includes(tag) || t.title?.includes(tag)).map((t: any) => t.id), ...(await fresh("todos"))])];
  const schs = await fresh("schedules"), acts = await fresh("actions");
  if (schs.length) await db.removeItems("schedules", schs);
  if (acts.length) await db.removeItems("actions", acts);
  const cms = (await db.getCollection("comms")).filter((c: any) => c.id.includes(tag)).map((c: any) => c.id);
  if (evs.length) await db.removeItems("events", evs);
  if (tds.length) await db.removeItems("todos", tds);
  if (cms.length) await db.removeItems("comms", cms);
  await db.redis.del(`task:${chat}`, `task_thread:${chat}`, `reactions:${chat}`);
  await db.redis.srem("tasks_index", chat);
  await db.redis.srem("tasks_active", chat);
  console.log(`(cleaned up ${evs.length} events, ${tds.length} to-dos, ${schs.length} schedules, ${acts.length} approvals, ${cms.length} messages, the test chat)`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
