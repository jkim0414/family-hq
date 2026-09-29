import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authorized, json } from "../_lib/http.js";
import { getCollection } from "../_lib/db.js";
import { sendEmail } from "../_lib/email.js";
import { selectForDigest, isTodoUrgent } from "../../src/data/digest.js";
import { toHomeZone, fmt12 } from "../../src/data/tz.js";
import { ensureSeasonalSuggestions } from "../_lib/metadata.js";
import { personName, peopleOf, ownerOf } from "../../src/data/people.js";
import { getWorkCalConfig, getWorkBlocks, summarizeDay, commutesDaily } from "../_lib/workcal.js";
import { wallToUtc } from "../../src/data/tz.js";
import { dayOutlook, eventWeatherNote } from "../_lib/weather.js";
import { leaveByTime } from "../_lib/travel.js";

const TZ = "America/Los_Angeles";

function todayPT(): string {
  // YYYY-MM-DD in Pacific time.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function daysUntil(iso: string, today: string): number {
  const a = new Date(today + "T00:00:00").getTime();
  const b = new Date(iso + "T00:00:00").getTime();
  return Math.round((b - a) / 86400000);
}

function relDay(iso: string, today: string): string {
  const n = daysUntil(iso, today);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// GET /api/digest?mode=daily|weekly&secret=...
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
  const mode = req.query.mode === "weekly" ? "weekly" : "daily";
  const dryRun = req.query.dry === "1";

  try {
    const [allEvents, allTodos] = await Promise.all([
      getCollection("events"),
      getCollection("todos"),
    ]);
    const today = todayPT();
    await ensureSeasonalSuggestions(new Date().toISOString()).catch(() => {});
    const who = (item: { people?: string[]; kidIds?: string[]; owner?: string[] }) => {
      const f = peopleOf(item).map(personName);
      const o = ownerOf(item).map(personName).filter((n) => !f.includes(n));
      const parts: string[] = [];
      if (f.length) parts.push(f.join(" & "));
      if (o.length) parts.push(`resp ${o.join(" & ")}`);
      return parts.length ? ` (${parts.join(" · ")})` : "";
    };

    const { events: upcoming, todos: open, prep } = selectForDigest(allEvents, allTodos, today, mode);

    const section = (title: string, items: string[]) =>
      `<h3 style="margin:18px 0 6px">${title}</h3>` +
      (items.length
        ? `<ul style="margin:0;padding-left:20px">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`
        : `<p style="margin:0;color:#888">none</p>`);

    const heading =
      mode === "daily"
        ? `☀️ Family HQ — ${new Date(today + "T12:00:00").toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}`
        : `🗓️ Family HQ — the week ahead`;

    // Work context (read-only): how each parent's day(s) look.
    const workLines: string[] = [];
    const span = mode === "daily" ? 1 : 7;
    for (const p of ["alex", "sam"] as const) {
      if (!(await getWorkCalConfig(p).catch(() => null))) continue;
      try {
        const from = wallToUtc(today, "00:00", TZ);
        // Read at least a week so we can tell whether commuting is this parent's daily norm.
        const blocks = await getWorkBlocks(p, from, new Date(+from + Math.max(span, 7) * 86400000));
        const officeDays = !commutesDaily(blocks);
        const days = Array.from({ length: span }, (_, i) => new Date(+from + i * 86400000 + 12 * 3600000).toISOString().slice(0, 10));
        const parts = days.map((d) => ({ d, s: summarizeDay(blocks, d, { officeDays }) })).filter((x) => x.s);
        if (!parts.length) continue;
        const name = p === "alex" ? "Alex" : "Sam";
        workLines.push(
          mode === "daily"
            ? `<b>${name}</b>: ${parts[0].s}`
            : `<b>${name}</b>: ${parts.map((x) => `${relDay(x.d, today)} — ${x.s}`).join("; ")}`
        );
      } catch (e) {
        console.error("digest work calendar", p, e);
      }
    }

    // Weather (daily: today's outlook) and per-event notes: rain/heat for outdoor events, leave-by times.
    const todayWx = mode === "daily" ? await dayOutlook(today).catch(() => null) : null;
    const notes = new Map<string, string>();
    for (const e of upcoming) {
      const t = toHomeZone(e);
      const bits: string[] = [];
      const wx = await eventWeatherNote(e, t.date, t.start, t.end).catch(() => null);
      if (wx) bits.push(wx);
      if (!e.allDay && t.start && e.travelMin && e.travelMin >= 10 && e.travelMin <= 180) bits.push(`🚗 ~${e.travelMin} min, leave by ${fmt12(leaveByTime(t.start, e.travelMin))}`);
      if (bits.length) notes.set(e.id, bits.join(" · "));
    }

    const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 4px">${heading}</h2>
${todayWx ? `<p style="margin:4px 0 0;color:#555">🌤 Today's weather: ${todayWx}</p>` : ""}
${workLines.length ? section("💼 Work", workLines) : ""}
${section(
  "📅 Events",
  upcoming.map((e) => {
    // Display in the home zone (PT); the stored time is source-zone wall time.
    const t = toHomeZone(e);
    const span = e.allDay && e.endDate && e.endDate !== e.date ? ` through ${relDay(e.endDate, today)}` : "";
    return `<b>${e.title}</b>${who(e)} — ${relDay(t.date, today)}${span}${
      t.start ? ` ${fmt12(t.start)} PT` : ""
    }${e.location ? ` · ${e.location}` : ""}${notes.get(e.id) ? `<br><span style="color:#555">${notes.get(e.id)}</span>` : ""}`;
  })
)}
${section(
  "✅ Needs action",
  open.map(
    (t) =>
      `${isTodoUrgent(t, today) ? "❗ " : ""}<b>${t.title}</b>${who(t)}${
        t.due ? " — " + relDay(t.due, today) : ""
      }`
  )
)}
${prep.length ? section("📝 Notes", prep.map((e) => `${relDay(toHomeZone(e).date, today)} · <b>${e.title}</b>: ${e.prep}`)) : ""}
<p style="margin-top:20px"><a href="https://your-app.vercel.app">Open the hub →</a></p>
</div>`;

    if (dryRun) {
      res.setHeader("content-type", "text/html");
      return res.status(200).send(html);
    }

    const toOverride = typeof req.query.to === "string" ? [req.query.to] : undefined;
    await sendEmail(heading, html, { to: toOverride });
    json(res, 200, { ok: true, mode, events: upcoming.length, todos: open.length, to: toOverride });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err) });
  }
}
