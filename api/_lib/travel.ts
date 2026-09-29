import { redis, getProfile, getCollection, setCollection } from "./db.js";
import { notify } from "./notify.js";
import { toHomeZone, fmt12, HOME_TZ } from "../../src/data/tz.js";
import { ownerOf } from "../../src/data/people.js";

// ─────────────────────────────────────────────────────────────────────────────
// Drive time from home to an event, for "leave by" times. Geocoding by
// OpenStreetMap Nominatim (optionally limited to your region with TRAVEL_VIEWBOX, so a same-named
// place far away isn't picked — trips outside it get no leave-by time) and routing by the OSRM public server — free, no key,
// fine at a family's volume (a handful of lookups a day, all cached). Neither
// knows live traffic, so estimates are padded (×1.25, +3 min).
// ─────────────────────────────────────────────────────────────────────────────

const UA = "FamilyHQ/1.0 (+https://your-app.vercel.app)";
type Pt = { lat: number; lon: number };

const SKIP_RE = /\b(zoom|virtual|online|tbd|tba|meet\.google|teams\.microsoft|webex|phone call|conference call|at home|our house)\b|^https?:\/\//i;
export function skipLocation(loc: string): boolean {
  return !loc.trim() || SKIP_RE.test(loc);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastNominatim = 0;
// Optional "minLon,maxLat,maxLon,minLat" box around where you live.
const VIEWBOX = process.env.TRAVEL_VIEWBOX || "";
// Optional state/region appended to bare place names, e.g. "NY" (TRAVEL_REGION).
const REGION = process.env.TRAVEL_REGION || "";

async function nominatim(q: string): Promise<Pt | null> {
  // Usage policy: at most one request per second.
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us${VIEWBOX ? `&viewbox=${VIEWBOX}&bounded=1` : ""}&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "user-agent": UA } }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => [])) as { lat: string; lon: string }[];
  return j[0] ? { lat: Number(j[0].lat), lon: Number(j[0].lon) } : null;
}

/** Coordinates for a place name or address (cached; misses cached for two weeks). */
export async function geocode(place: string): Promise<Pt | null> {
  const key = `geo:${norm(place).slice(0, 180)}`;
  const cached = await redis.get<Pt | "none">(key).catch(() => null);
  if (cached) return cached === "none" ? null : cached;
  const first = place.split(",")[0].trim();
  // Map data spells names out: "St. Mary's" is "Saint Mary".
  const spelled = place.replace(/\bSt\.?\s+(?=[A-Z])/g, "Saint ").replace(/(\w)['’]s\b/g, "$1");
  // Map data misses some buildings (a church, a party venue); the name without generic words
  // ("St Mary, Springfield") usually lands on the same block.
  const core = place.replace(/(\w)['’]s\b/g, "$1").replace(/\b(catholic|episcopal|lutheran|methodist|presbyterian|church|parish|chapel|cathedral|temple)\b/gi, "").replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").trim();
  // A street address inside the location ("Smile Dental, 100 Oak St, Springfield") beats the business
  // name — and when there is one, never fall back to the bare name, which can match somewhere else.
  const segs = place.split(",").map((x) => x.trim());
  const at = segs.findIndex((x) => /^\d+\s+\S/.test(x));
  const address = at >= 0 ? segs.slice(at).join(", ") : "";
  const tries = address
    ? [address, REGION && !address.includes(REGION) ? `${address}, ${REGION}` : "", place]
    : [place, REGION && !place.includes(REGION) ? `${place}, ${REGION}` : "", spelled !== place ? spelled : "", core !== place ? core : "", first !== place ? (REGION ? `${first}, ${REGION}` : first) : ""];
  const queries = tries.filter(Boolean);
  let pt: Pt | null = null;
  for (const q of queries) {
    pt = await nominatim(q);
    if (pt) break;
  }
  await redis.set(key, pt || "none", { ex: pt ? 180 * 86400 : 14 * 86400 }).catch(() => {});
  return pt;
}

export async function homeAddress(): Promise<string | null> {
  const body = (await getProfile()).sections.find((s) => s.key === "home")?.body || "";
  const line = body.split("\n").find((l) => /\d+ .+\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|way|blvd|ct|court|pl|place)\b/i.test(l)) || body.split("\n")[0];
  return line?.trim() || null;
}

/** Estimated minutes to drive from home to `place`, or null if it can't be placed/routed. */
export async function driveMinutesFromHome(place: string): Promise<number | null> {
  if (skipLocation(place)) return null;
  const home = await homeAddress();
  if (!home) return null;
  if (norm(place).includes(norm(home).split(",")[0])) return 0;
  const [a, b] = [await geocode(home), await geocode(place)];
  if (!a || !b) return null;
  const rk = `route:${a.lat.toFixed(3)},${a.lon.toFixed(3)}>${b.lat.toFixed(3)},${b.lon.toFixed(3)}`;
  const cached = await redis.get<number>(rk).catch(() => null);
  if (cached != null) return cached;
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`, { headers: { "user-agent": UA } }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as { routes?: { duration: number }[] } | null;
  const sec = j?.routes?.[0]?.duration;
  if (typeof sec !== "number") return null;
  const min = Math.round((sec / 60) * 1.25 + 3);
  await redis.set(rk, min, { ex: 30 * 86400 }).catch(() => {});
  return min;
}

/** "HH:mm" minus minutes (drive + a 5-minute buffer). */
export function leaveByTime(start: string, driveMin: number, bufferMin = 5): string {
  const [h, m] = start.split(":").map(Number);
  const t = h * 60 + m - driveMin - bufferMin;
  const hh = Math.floor(((t % 1440) + 1440) % 1440 / 60);
  const mm = ((t % 60) + 60) % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

const todayPT = () => new Date().toLocaleDateString("en-CA", { timeZone: HOME_TZ });
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * Hourly: estimate the drive from home for the coming week's timed events that have a
 * location. Recomputed only when an event's location changes; at most `max` lookups a run.
 */
export async function updateTravelTimes(max = 8): Promise<{ checked: number; updated: number }> {
  const events = await getCollection("events");
  const today = todayPT();
  const horizon = plusDays(today, 7);
  let checked = 0;
  let updated = 0;
  for (const e of events) {
    if (checked >= max) break;
    if (e.allDay || !e.start || !e.location) continue;
    const d = toHomeZone(e).date;
    if (d < today || d > horizon) continue;
    if (e.travelFor === e.location) continue;
    checked++;
    const min = await driveMinutesFromHome(e.location).catch(() => null);
    e.travelFor = e.location;
    e.travelMin = min ?? undefined;
    updated++;
  }
  if (updated) await setCollection("events", events);
  return { checked, updated };
}

/**
 * Every few minutes: a push ~10 minutes before it's time to leave for today's events
 * that are a real drive away (10 min – 3 h). To the event's responsible parents, else both.
 * Push only — an email would arrive too late to matter.
 */
export async function checkLeaveAlerts(): Promise<number> {
  const events = await getCollection("events");
  const today = todayPT();
  const now = new Date().toLocaleTimeString("en-GB", { timeZone: HOME_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  let sent = 0;
  for (const e of events) {
    if (e.allDay || !e.travelMin || e.travelMin < 10 || e.travelMin > 180) continue;
    const t = toHomeZone(e);
    if (t.date !== today || !t.start) continue;
    const leave = leaveByTime(t.start, e.travelMin);
    const until = mins(leave) - mins(now);
    if (until > 15 || until < 4) continue;
    if (!(await redis.set(`leave_alert:${e.id}:${today}`, "1", { nx: true, ex: 2 * 86400 }).catch(() => null))) continue;
    const owners = ownerOf(e).filter((o): o is "alex" | "sam" => o === "alex" || o === "sam");
    const to: ("alex" | "sam")[] = owners.length ? owners : ["alex", "sam"];
    const text = `🚗 Leave by ${fmt12(leave)} for ${e.title} (about ${e.travelMin} min drive${e.location ? ` to ${e.location}` : ""}).`;
    for (const p of to) await notify(p, text, "app", { emailFallback: false }).catch((err) => console.error("leave alert failed", err));
    sent++;
  }
  return sent;
}
