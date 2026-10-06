import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { redis } from "../_lib/db.js";
import { smsConfigured, getSmsOptIn } from "../_lib/notify.js";
import { browserConfigured } from "../_lib/browser.js";
import { opConfigured } from "../_lib/onepassword.js";
import { pushConfigured } from "../_lib/push.js";
import { weatherConfigured } from "../_lib/weather.js";
import { getWorkCalConfig, type Parent } from "../_lib/workcal.js";
import { CONFIG } from "../../src/data/config.js";

// GET /api/setup — which connectors are set up, for the Kimi tab's Setup checklist. Each item is
// on/off plus a short status; never a key, token, or address. "guide" is the section of SETUP.md.
type Item = { id: string; label: string; what: string; required?: boolean; on: boolean; status?: string; guide: string };
const PARENTS = Object.keys(CONFIG.parents) as Parent[];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  const env = (...keys: string[]) => keys.every((k) => !!process.env[k]);
  const [seen, googleToken, workcals, optins] = await Promise.all([
    redis.get<number>("ingest_seen").catch(() => null),
    process.env.GOOGLE_REFRESH_TOKEN ? Promise.resolve("env") : redis.get<string>("google_refresh_token").catch(() => null),
    Promise.all(PARENTS.map((p) => getWorkCalConfig(p).catch(() => null))),
    Promise.all(PARENTS.map((p) => getSmsOptIn(p).catch(() => null))),
  ]);
  const minutes = seen ? Math.round((Date.now() - Number(seen)) / 60000) : null;
  const gmails = PARENTS.filter((p) => env(`GMAIL_IMAP_${p.toUpperCase()}_USER`, `GMAIL_IMAP_${p.toUpperCase()}_PASS`)).length;
  const googleKeys = env("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  const of = (n: number) => `${n} of ${PARENTS.length}`;

  const items: Item[] = [
    { id: "claude", label: "Claude", what: "Kimi's brain", required: true, on: env("ANTHROPIC_API_KEY"), guide: "claude" },
    { id: "database", label: "Database", what: "Where everything is kept (Upstash Redis)", required: true, on: env("KV_REST_API_URL", "KV_REST_API_TOKEN") || env("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"), guide: "database" },
    {
      id: "heartbeat",
      label: "Every-minute heartbeat",
      what: "Checks email, resumes jobs, runs scheduled tasks",
      required: true,
      on: minutes !== null && minutes <= 20,
      status: minutes === null ? "hasn't run yet" : minutes <= 1 ? "running" : `last run ${minutes} min ago`,
      guide: "heartbeat",
    },
    {
      id: "google-calendar",
      label: "Google Calendar",
      what: "The family calendar Kimi files to",
      required: true,
      on: googleKeys && !!googleToken,
      status: !googleKeys ? "keys not set" : googleToken ? "connected" : "keys set — connect it once (see guide)",
      guide: "google-calendar",
    },
    { id: "kimi-inbox", label: "Kimi's email", what: "Her own inbox: forwarded mail, and the address she writes from", required: true, on: env("IMAP_USER", "IMAP_PASS"), guide: "kimi-email" },
    { id: "parents-gmail", label: "Parents' Gmail", what: "Watches each parent's inbox (read-only)", on: gmails > 0, status: `${of(gmails)} connected`, guide: "parents-gmail" },
    { id: "work-calendars", label: "Work calendars", what: "Plans around meetings and travel", on: workcals.some(Boolean), status: `${of(workcals.filter(Boolean).length)} connected`, guide: "work-calendars" },
    {
      id: "texting",
      label: "Texting",
      what: "Text Kimi one-on-one and in a family group text (Twilio)",
      on: smsConfigured(),
      status: smsConfigured() ? `${of(optins.filter((o) => o === "enrolled").length)} parents opted in` : undefined,
      guide: "texting",
    },
    { id: "browser", label: "Web tasks", what: "Registers, orders, and books in a real browser (Browserbase)", on: browserConfigured(), guide: "web-tasks" },
    { id: "vault", label: "Logins & cards", what: "Signs in and pays without seeing passwords or cards (1Password)", on: opConfigured() || env("VAULT_KEY"), status: opConfigured() ? "1Password" : env("VAULT_KEY") ? "built-in vault" : undefined, guide: "logins-and-cards" },
    { id: "push", label: "Push notifications", what: "Alerts on your phone from the installed app", on: pushConfigured(), guide: "push" },
    { id: "weather", label: "Weather", what: "Forecasts in the digest and on outdoor events", on: weatherConfigured(), guide: "weather" },
  ];
  json(res, 200, { items });
}
