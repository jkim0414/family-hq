#!/usr/bin/env tsx
// Measure Kimi's chat context (old sliding window vs. compacted) and verify the prompt
// cache is reused across two consecutive turns. Calls the API directly; nothing is saved.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const { getTask } = await import("../api/_lib/db");
const { systemPrompt, toolsFor, trimThread, withCacheBreakpoint } = await import("../api/_lib/agent");
const client = new Anthropic();
const MODEL = process.env.AGENT_MODEL || "claude-opus-5";
const task: any = await getTask("task-main");
const thread = structuredClone(task.thread);
const system = await systemPrompt(task);
const tools = toolsFor(task);
const count = async (messages: any[]) => (await client.messages.countTokens({ model: MODEL, system, tools, messages })).input_tokens;

const oldWindow = thread.slice(-60);
while (oldWindow.length && !(oldWindow[0].role === "user" && (typeof oldWindow[0].content === "string" || !oldWindow[0].content.some((b: any) => b.type === "tool_result")))) oldWindow.shift();
const probe = { role: "user", content: "(cache check) Reply with just: ok" };
console.log("tokens per call — old:", await count([...oldWindow, probe]), " new:", await count(trimThread([...thread, probe])));

const call = async (messages: any[]) => {
  const r: any = await client.messages.create({ model: MODEL, max_tokens: 300, system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }], tools, output_config: { effort: "low" }, messages: withCacheBreakpoint(messages) } as any);
  const u = r.usage;
  return { r, u: { input: u.input_tokens, cacheWrite: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens, output: u.output_tokens } };
};
let msgs = trimThread([...thread, { role: "user", content: "(cache check A — not from a parent) Reply with just: ok" }]);
const a = await call(msgs);
console.log("turn A:", a.u);
msgs = trimThread([...msgs, { role: "assistant", content: a.r.content }, { role: "user", content: "(cache check B — not from a parent) Reply with just: ok" }]);
const b = await call(msgs);
console.log("turn B:", b.u);
process.exit(0);
