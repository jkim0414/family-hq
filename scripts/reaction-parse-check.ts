#!/usr/bin/env tsx
// Unit checks for tapback texts (api/_lib/reactions.ts). No network, no writes.
const { parseReactionText, isOffer } = await import("../api/_lib/reactions");
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`);
};
const p = (t: string) => { const r = parseReactionText(t); return r && [r.emoji, r.quoted]; };
eq("iOS like, curly, truncated", p("Liked “Kimi (Family HQ): Yep — I'll text you Saturday morning about the snacks…”"), ["👍", "Kimi (Family HQ): Yep — I'll text you Saturday morning about the snacks…"]);
eq("straight quotes", p('Liked "Who are you?"'), ["👍", "Who are you?"]);
eq("loved", p("Loved “Nice!”"), ["❤️", "Nice!"]);
eq("laughed at", p("Laughed at “lol”"), ["😂", "lol"]);
eq("emphasized", p("Emphasized “Leave by 3”"), ["‼️", "Leave by 3"]);
eq("questioned", p("Questioned “Moved to 4pm”"), ["❓", "Moved to 4pm"]);
eq("disliked", p("Disliked “Rain Saturday”"), ["👎", "Rain Saturday"]);
eq("iOS 18 emoji", p("Reacted 🎉 to “We're booked”"), ["🎉", "We're booked"]);
eq("removed a like", p("Removed a like from “Who are you?”"), [null, "Who are you?"]);
eq("removed emoji", p("Removed 🎉 from “We're booked”"), [null, "We're booked"]);
eq("android emoji-to", p('👍 to "See you at 5"'), ["👍", "See you at 5"]);
eq("multi-line quote", p("Liked “line one\nline two”"), ["👍", "line one\nline two"]);
eq("ordinary text", p("I liked the zoo idea"), null);
eq("starts with Liked but not a tapback", p("Liked the plan, let's do it"), null);
const e = (text: string) => ({ at: "x", kind: "assistant" as const, text });
eq("offer", isOffer(e("Nice! Want me to put a plan on the calendar?")), true);
eq("offer with emoji", isOffer(e("Want me to grab Saturday? ☀️")), true);
eq("statement", isOffer(e("Added swim Tuesday at 4:30.")), false);
eq("approval is never an offer", isOffer(e("Needs your approval — Place order?\n\nReply APPROVE or DECLINE.")), false);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
