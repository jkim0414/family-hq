import Anthropic from "@anthropic-ai/sdk";
import { redis, getCollection, setCollection } from "./db.js";
import { recordUsage } from "./usage.js";
import { normTitle } from "./workcal.js";
import { toHomeZone, fmt12, HOME_TZ } from "../../src/data/tz.js";
import type { CalEvent } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Is a long event come-and-go (an open house, a festival, "stop by any time 1–5") or attended
// start to finish (a field trip someone chaperones, a tournament)? Only a drop-in one is spared a
// work hold and a meeting-clash check. Filing sets it from the message; this judges the rest
// (events from Google, from chat, from before the field existed) by title, once per title.
// ─────────────────────────────────────────────────────────────────────────────

const LONG_MIN = 3 * 60;
const HORIZON_DAYS = 42;
const KEY = "dropin_kind";
const MODEL = "claude-sonnet-5-5";
const client = new Anthropic();

const minutes = (hhmm?: string) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : 0);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Long enough that it might be come-and-go. */
export function isLong(e: CalEvent): boolean {
  if (e.allDay || !e.start || !e.end || (e.endDate && e.endDate !== e.date)) return false;
  return minutes(e.end) - minutes(e.start) > LONG_MIN;
}

async function judge(items: { title: string; when: string; where?: string; prep?: string }[]): Promise<Record<string, boolean>> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: "user", content: `These are long events on a family's calendar. For each, decide whether it's DROP-IN: a window people come and go from whenever suits them (an open house, a festival or fair, a fundraiser night, an exhibit, "stop by any time"). Otherwise it's ATTENDED start to finish (a field trip, a tournament, a workshop, a party, a flight, a service someone must be home for).
${items.map((x, i) => `${i}. "${x.title}" ${x.when}${x.where ? ` at ${x.where}` : ""}${x.prep ? ` (${x.prep.slice(0, 120)})` : ""}`).join("\n")}
Reply with JSON only: {"0": true, "1": false, ...} (true = drop-in)` }],
  });
  recordUsage("dropin", MODEL, res.usage);
  const text = res.content.find((b) => b.type === "text")?.text || "{}";
  const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return Object.fromEntries(items.map((x, i) => [x.title, j[String(i)] === true]));
}

/** Hourly: decide drop-in for upcoming long events that don't say. Returns how many were marked. */
export async function markDropIns(): Promise<number> {
  const events = await getCollection("events");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: HOME_TZ });
  const horizon = plusDays(today, HORIZON_DAYS);
  const open = events.filter((e) => e.dropIn === undefined && e.date >= today && e.date <= horizon && isLong(e));
  if (!open.length) return 0;
  const known = ((await redis.hgetall<Record<string, string>>(KEY).catch(() => null)) || {}) as Record<string, string>;
  const fresh = [...new Map(open.filter((e) => !(normTitle(e.title) in known)).map((e) => [e.title, e])).values()].slice(0, 30);
  if (fresh.length) {
    const judged = await judge(fresh.map((e) => {
      const h = toHomeZone(e);
      return { title: e.title, when: `${h.date} ${fmt12(h.start!)}–${fmt12(h.end!)}`, where: e.location, prep: e.prep };
    })).catch(() => null);
    if (!judged) return 0;
    const upd = Object.fromEntries(fresh.map((e) => [normTitle(e.title), judged[e.title] ? "yes" : "no"]));
    await redis.hset(KEY, upd).catch(() => {});
    Object.assign(known, upd);
  }
  let marked = 0;
  for (const e of open) {
    const k = known[normTitle(e.title)];
    if (!k) continue;
    e.dropIn = k === "yes";
    marked++;
  }
  if (marked) await setCollection("events", events);
  return marked;
}
