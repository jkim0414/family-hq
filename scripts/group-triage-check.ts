#!/usr/bin/env tsx
// Does the group-text triage tell "for Kimi" from "the parents talking to each other"? A few cents of API use.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { shouldReply } = await import("../api/_routes/smsgroup");
const { getProfile } = await import("../api/_lib/db");
const { profileContext } = await import("../api/_lib/classify");
const household = profileContext(await getProfile());
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();
type L = { who: "Alex" | "Sam" | "Kimi"; text: string; min: number };
const plan: L[] = [
  { who: "Alex", text: "Kimi, any ideas for Saturday with Max and Theo?", min: 25 },
  { who: "Kimi", text: "Ooh, fun! The botanical garden, the children's museum, or a bike loop at the reservoir… Want me to put a plan on the calendar?", min: 24 },
  { who: "Sam", text: "Isn't the children's museum closed for renovations?", min: 23 },
  { who: "Kimi", text: "Good news, Sam — it reopened last month! Open daily 9–4.", min: 22 },
  { who: "Alex", text: "I'm moving my morning errand", min: 21 },
  { who: "Kimi", text: "Nice, Alex! Then Saturday's wide open. Want me to put a plan on the calendar?", min: 18 },
];
const quiet: L[] = [{ who: "Sam", text: "Home in 20", min: 3 }];
const cases: [string, L[], string, string, boolean][] = [
  ["follow-up that adds a new idea to her plan", plan, "Alex", "We have a zoo membership. What if we did the zoo in the morning and a picnic after? Maybe Sam and Grandma could join for lunch", true],
  ["yes to her offer", plan, "Alex", "yes please", true],
  ["no to her offer", plan, "Alex", "no we're good", true],
  ["info question, no Kimi context", quiet, "Sam", "Is the zoo open on Mondays?", true],
  ["schedule question", quiet, "Alex", "What time is Theo's piano tomorrow?", true],
  ["errand for the other parent", plan, "Alex", "Babe can you grab milk on the way home?", false],
  ["ETA", plan, "Sam", "running 10 min late", false],
  ["who's doing bath", quiet, "Sam", "Who's doing bath tonight?", false],
  ["see you later", plan, "Sam", "ok see you at 5", false],
  ["affection", quiet, "Alex", "love you", false],
  ["preference between parents", quiet, "Sam", "Do you want tacos or pasta tonight?", false],
  ["thanks after her help (quiet is fine in a group)", plan, "Sam", "thanks!", false],
];
let pass = 0;
for (const [label, hist, who, t, want] of cases) {
  const got = await shouldReply(who, t, hist.map((h, i) => ({ sid: `x${i}`, who: h.who, text: h.text, at: at(h.min) })), household);
  if (got === want) pass++;
  console.log(got === want ? "PASS" : "FAIL", label, "→", got);
}
console.log(`${pass}/${cases.length}`);
