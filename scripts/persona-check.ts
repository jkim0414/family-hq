#!/usr/bin/env tsx
// Does Kimi's personality come through? Sends the same everyday messages to two versions of the
// agent's instructions and a blind judge compares them against the persona.
//   default:              with vs. without the WHO YOU ARE section
//   --baseline <file>:    current instructions vs. a saved earlier version (a before/after check)
//   --thread:             send each message on top of the real family-chat history (style drift)
// Usage: npx tsx scripts/persona-check.ts <report.md> [--baseline prompt.txt] [--thread] Tool calls are answered with
// (lookups return prepared facts), so the only difference is the persona. ~$2–4 of API use.
import { readFileSync, writeFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim(); }
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const { getTask } = await import("../api/_lib/db");
const { systemPrompt, toolsFor, trimThread } = await import("../api/_lib/agent");
const client = new Anthropic();
const MODEL = process.env.AGENT_MODEL || "claude-opus-5";
const task: any = await getTask("task-main");
const full = await systemPrompt(task);
const start = full.indexOf("WHO YOU ARE"), end = full.indexOf("HOW YOU WORK");
const persona = full.slice(start, end);
const argv = process.argv.slice(2);
const baselineFile = argv.includes("--baseline") ? argv[argv.indexOf("--baseline") + 1] : "";
const other = baselineFile ? readFileSync(baselineFile, "utf8") : full.slice(0, start) + full.slice(end);
const LABEL_A = "Current", LABEL_B = baselineFile ? "Baseline" : "No persona";
const history: any[] = argv.includes("--thread") ? trimThread(structuredClone(task.thread || [])) : [];
const tools = toolsFor(task);
// [who, message, what any lookup returns]
const CASES: [string, string, string][] = [
  ["Alex", "Max lost his first tooth today!!", "Nothing on the calendar about this."],
  ["Sam", "What's on for tomorrow?", "Tue Mar 10: Picture Day (Max & Theo). Theo piano lesson 5:00pm. Weather: cloudy, 58°F."],
  ["Alex", "Ugh, I totally forgot about the soccer snack sign-up for Saturday.", "To-do 'Sign up for snacks – Max's soccer game 3/14' due Fri Mar 13, not done. The sign-up link is in the team's schedule email. No one from the family has signed up yet; two slots are still open."],
  ["Sam", "Ava has a fever. Do we need to cancel anything tomorrow?", "Ava, Tue Mar 10: preschool as usual. No appointments, activities, or events for Ava."],
  ["Alex", "Thanks Kimi!", "(no lookup needed)"],
  ["Alex", "How much did we spend on DoorDash this month?", "3 purchases, $64.20 total: Sep 3 $31.10, Sep 11 $18.45 (bagels), Sep 19 $14.65."],
  ["Sam", "Is Friday's no-school day covered?", "Fri Mar 13: No School – Teacher Workday (Max & Theo). Event note: 'Covered: Max & Theo are at day camp.'"],
  ["Alex", "Morning! Anything I should know about today?", "Mon Mar 9: library books due back for Max (to-do). Theo piano 5:00pm. Weather sunny, 64°F. No pending approvals."],
];
const ask = async (system: string, who: string, text: string, lookup: string) => {
  const messages: any[] = [...history, { role: "user", content: `[${who} · app · Mon Mar 9, 8:10 AM PT]\n${text}` }];
  for (let step = 0; step < 4; step++) {
    const r: any = await client.messages.create({ model: MODEL, max_tokens: 1500, system, tools, output_config: { effort: "medium" }, messages } as any);
    const uses = r.content.filter((b: any) => b.type === "tool_use");
    if (!uses.length) return r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    messages.push({ role: "assistant", content: r.content });
    // Every lookup returns the same prepared facts; any write is acknowledged without doing anything.
    messages.push({ role: "user", content: uses.map((u: any) => ({ type: "tool_result", tool_use_id: u.id, content: /^(get_|search|directory|list_|read_)/.test(u.name) ? lookup : `OK (${u.name} done)` })) });
  }
  return "(no final reply)";
};
const rows: { who: string; msg: string; withP: string; without: string }[] = [];
for (const [who, msg, lookup] of CASES) rows.push({ who, msg, withP: await ask(full, who, msg, lookup), without: await ask(other, who, msg, lookup) });

// Blind judge: randomized A/B order.
const judgeSys = `You compare two replies from a family's AI assistant to the same message. One was written with this persona's instructions and one with other instructions:\n---\n${persona}\n---\nYou don't know which is which. For EACH reply, rate 1–5 how clearly it shows a distinct character matching the persona (warmth, a little playfulness, uses the parent's name, cheers the kids briefly, calm on health/money, brief) versus sounding like a generic AI assistant (5 = unmistakably this persona, 1 = generic assistant). Then say which reply is the persona one, or "can't tell". Reply ONLY with JSON: {"a":n,"b":n,"persona":"A"|"B"|"can't tell","why":"one sentence"}`;
let correct = 0, cantTell = 0, sumWith = 0, sumWithout = 0;
const out: string[] = [];
for (const r of rows) {
  const flip = Math.random() < 0.5;
  const A = flip ? r.without : r.withP, B = flip ? r.withP : r.without;
  const j: any = await client.messages.create({ model: MODEL, max_tokens: 400, system: judgeSys, messages: [{ role: "user", content: `PARENT (${r.who}): ${r.msg}\n\nREPLY A:\n${A}\n\nREPLY B:\n${B}` }] } as any);
  const txt = j.content.find((b: any) => b.type === "text")?.text || "{}";
  const v = JSON.parse(txt.match(/\{[\s\S]*\}/)![0]);
  const withScore = flip ? v.b : v.a, withoutScore = flip ? v.a : v.b;
  const truth = flip ? "B" : "A";
  if (v.persona === truth) correct++; else if (v.persona === "can't tell") cantTell++;
  sumWith += withScore; sumWithout += withoutScore;
  out.push(`### ${r.who}: ${r.msg}\n\n**${LABEL_A}** (${withScore}/5):\n${r.withP}\n\n**${LABEL_B}** (${withoutScore}/5):\n${r.without}\n\n_Judge: picked ${v.persona === truth ? "correctly" : v.persona === "can't tell" ? "can't tell" : "WRONG"} — ${v.why}_\n`);
}
const summary = `${LABEL_A} vs ${LABEL_B}${history.length ? " (on the real chat history)" : ""}: judge picked ${LABEL_A} as the persona reply ${correct}/${rows.length} times (can't tell: ${cantTell}). Avg persona score: ${LABEL_A} ${(sumWith / rows.length).toFixed(1)}/5, ${LABEL_B} ${(sumWithout / rows.length).toFixed(1)}/5.`;
writeFileSync(process.argv[2] || "persona-check.md", `# Persona check\n\n${summary}\n\n${out.join("\n")}`);
console.log(summary);
process.exit(0);
