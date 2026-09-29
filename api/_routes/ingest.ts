import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authorized, json } from "../_lib/http.js";
import { fetchUnseen, markSeen } from "../_lib/imap.js";
import { isUidSeen, markUidSeen, redis, setLastCalSync } from "../_lib/db.js";
import { importCalendarEvents, type CalSyncResult } from "../_lib/calsync.js";
import { runDueTasks } from "../_lib/agent.js";
import { fileMessages, type FileInput } from "../_lib/file-mail.js";
import { runWatch, type WatchStats } from "../_lib/watch.js";
import { sweepVerifiable } from "../_lib/verify.js";
import { updateTravelTimes, checkLeaveAlerts } from "../_lib/travel.js";

// Senders that are infrastructure noise, never school comms.
const SKIP_SENDERS = [/accounts\.google\.com/i, /no-?reply@google/i, /mailer-daemon/i];

// GET/POST /api/ingest?secret=... — the heartbeat (cron-job.org, every minute):
// resume agent tasks, mirror the calendar, file new mail from the forwarding
// inbox, and watch the parents' own inboxes. Idempotent via seen tracking.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
  const quiet = req.query.quiet === "1"; // suppress alert emails + calendar invites (bulk backlog)
  const started = Date.now();

  try {
    // Resume agent tasks that are mid-work or have a due follow-up. This is the
    // "cloud worker": every cron tick gives the assistant a slice of time.
    let tasksRan = 0;
    try {
      tasksRan = await runDueTasks(110_000);
    } catch (e) {
      console.error("agent resume failed", e);
    }

    // Every later stage is time-gated. Read all the gates in ONE command: this runs
    // every minute, so an idle tick is now smembers + mget (tasks) + this mget.
    const [lastCal, watchAlex, watchSam, watchLast, verifyLast, schoolLast, travelLast, leaveLast] =
      (await redis
        .mget<unknown[]>("last_calsync", "watch:alex", "watch:sam", "watch_last", "verify_sweep_last", "school_inbox_last", "travel_last", "leave_check_last")
        .catch(() => null)) || [];
    const num = (v: unknown) => Number(v || 0);

    // Mirror the Personal calendar (time-gated to ~every 15 min so frequent
    // polls stay cheap). Best-effort; never blocks email ingest.
    let calendar: CalSyncResult | null = null;
    try {
      const now = Date.now();
      if (now - num(lastCal) >= 15 * 60 * 1000) {
        await setLastCalSync(now); // claim the window before working (overlap guard)
        calendar = await importCalendarEvents();
      }
    } catch (e) {
      console.error("calendar sync failed", e);
    }

    // Watch the parents' own Gmail (time-gated inside; best-effort).
    let watch: WatchStats | null = null;
    try {
      watch = await runWatch({ quiet, budgetMs: Math.max(15_000, 230_000 - (Date.now() - started)), pre: { enabled: { alex: watchAlex, sam: watchSam }, last: num(watchLast) } });
    } catch (e) {
      console.error("watch failed", e);
    }

    // Drive times for the coming week's events (hourly), and "leave by" pushes (every 5 min).
    let travel: { checked: number; updated: number } | null = null;
    let leaveAlerts = 0;
    try {
      if (Date.now() - num(leaveLast) >= 5 * 60 * 1000) {
        await redis.set("leave_check_last", Date.now());
        leaveAlerts = await checkLeaveAlerts();
      }
      if (Date.now() - num(travelLast) >= 60 * 60 * 1000 && Date.now() - started < 150_000) {
        await redis.set("travel_last", Date.now());
        travel = await updateTravelTimes();
      }
    } catch (e) {
      console.error("travel stage failed", e);
    }

    // Kimi's own inbox is now a manual-forwarding fallback (the parents' inboxes are
    // watched directly), so it doesn't need an IMAP login every minute.
    // Close RSVP / sign-up to-dos that turn out to be done already (hourly).
    let verified = 0;
    try {
      if (Date.now() - started < 200_000) verified = await sweepVerifiable(false, num(verifyLast));
    } catch (e) {
      console.error("verify sweep failed", e);
    }

    const lastSchool = num(schoolLast);
    if (Date.now() - lastSchool < 5 * 60 * 1000) {
      return json(res, 200, { ok: true, fetched: 0, filed: 0, skipped: 0, calendar, tasksRan, watch, verified, travel, leaveAlerts, schoolInbox: "not due" });
    }
    await redis.set("school_inbox_last", Date.now());
    const messages = await fetchUnseen(false);
    if (messages.length === 0) {
      return json(res, 200, { ok: true, fetched: 0, filed: 0, events: 0, updatedEvents: 0, todos: 0, alerts: 0, metaApplied: 0, metaSuggested: 0, duplicates: 0, skipped: 0, calendar, tasksRan, watch });
    }

    // Lock so overlapping runs don't double-process the same mail.
    const gotLock = await redis.set("ingest_lock", "1", { nx: true, ex: 120 });
    if (!gotLock) return json(res, 200, { ok: true, busy: true, watch });

    try {
      const toFile: FileInput[] = [];
      const skippedUids: number[] = [];
      for (const m of messages) {
        if (await isUidSeen(m.uid)) continue;
        if (SKIP_SENDERS.some((re) => re.test(m.from))) {
          skippedUids.push(m.uid);
          continue;
        }
        toFile.push({ ...m, key: String(m.uid), mailbox: "school" });
      }

      const stats = await fileMessages(toFile, { quiet });

      const processedUids = [...skippedUids, ...stats.processedKeys.map(Number)];
      for (const uid of processedUids) await markUidSeen(uid);
      await markSeen(processedUids).catch((e) => console.error("markSeen failed", e));

      json(res, 200, {
        ok: true,
        fetched: messages.length,
        filed: stats.filed,
        events: stats.events,
        updatedEvents: stats.updatedEvents,
        todos: stats.todos,
        alerts: stats.alerts,
        metaApplied: stats.metaApplied,
        metaSuggested: stats.metaSuggested,
        duplicates: stats.duplicates,
        skipped: skippedUids.length,
        calendar,
        tasksRan,
        watch,
      });
    } finally {
      await redis.del("ingest_lock").catch(() => {});
    }
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err) });
  }
}
