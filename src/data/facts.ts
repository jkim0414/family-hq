import type { Fact, FactTopic, HouseholdProfile } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Household facts: short, typed statements Kimi works from, grouped by topic and
// tagged with who they're about. Each has an id, so learning something new updates
// the fact it changes instead of piling up a second, contradicting one.
// Shared by the API (prompts, the remember tool) and the app (Household → Facts).
// ─────────────────────────────────────────────────────────────────────────────

export const FACT_TOPICS: { id: FactTopic; label: string }[] = [
  { id: "health", label: "Health & allergies" },
  { id: "food", label: "Food & preferences" },
  { id: "school", label: "School" },
  { id: "activities", label: "Activities & sports" },
  { id: "childcare", label: "Childcare & coverage" },
  { id: "work", label: "Work & availability" },
  { id: "home", label: "Home" },
  { id: "travel", label: "Travel" },
  { id: "vendors", label: "Go-to vendors & services" },
  { id: "gifts", label: "Gifts & occasions" },
  { id: "other", label: "Other" },
];
export const FACT_TOPIC_IDS = FACT_TOPICS.map((t) => t.id);
export const topicLabel = (t: string) => FACT_TOPICS.find((x) => x.id === t)?.label || "Other";
export const isFactTopic = (t: unknown): t is FactTopic => typeof t === "string" && (FACT_TOPIC_IDS as string[]).includes(t);

export function newFactId(): string {
  return `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// Old section keys → topics, for profiles saved before facts existed.
const LEGACY_TOPIC: Record<string, FactTopic> = {
  allergies: "health",
  diet: "food",
  vendors: "vendors",
  work: "work",
  childcare: "childcare",
  gifting: "gifts",
  home: "home",
};

/**
 * A profile in the current shape. An old one (free-text sections, no facts) becomes one fact
 * per line, so nothing is lost before it's been sorted properly (scripts/migrate-facts.ts).
 */
export function normalizeProfile(p: Partial<HouseholdProfile> | null | undefined): HouseholdProfile {
  const people = p?.people || [];
  if (p?.facts) return { facts: p.facts, people };
  const facts: Fact[] = [];
  let n = 0;
  for (const s of p?.sections || []) {
    const topic = LEGACY_TOPIC[s.key] || "other";
    for (const line of s.body.split("\n").map((l) => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean)) {
      facts.push({ id: `f-legacy-${n++}`, topic, text: line, updatedAt: "" });
    }
  }
  return { facts, people };
}

/** Facts for a prompt, grouped by topic. withIds: show ids so Kimi can update one. */
export function renderFacts(facts: Fact[], opts: { withIds?: boolean } = {}): string {
  const out: string[] = [];
  for (const t of FACT_TOPICS) {
    const fs = facts.filter((f) => (isFactTopic(f.topic) ? f.topic : "other") === t.id);
    if (!fs.length) continue;
    out.push(`${t.label}:`);
    for (const f of fs) out.push(`- ${opts.withIds ? `[${f.id}] ` : ""}${f.text}`);
  }
  return out.join("\n");
}

/** The first fact on a topic that matches (e.g. the home address). */
export function factText(p: HouseholdProfile, topic: FactTopic, re?: RegExp): string {
  return p.facts.find((f) => f.topic === topic && (!re || re.test(f.text)))?.text || "";
}
