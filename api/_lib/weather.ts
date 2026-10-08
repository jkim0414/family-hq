import { redis } from "./db.js";
import type { CalEvent } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Weather for planning, from the US National Weather Service (free, no key).
// Hourly forecast covers ~7 days; cached an hour. Used for outdoor events in
// digests ("rain likely during Saturday's soccer") and by Kimi's get_weather.
// ─────────────────────────────────────────────────────────────────────────────

const UA = "FamilyHQ/1.0 (+https://your-app.vercel.app)";
// Home location for forecasts (US only — NWS): set WEATHER_LAT / WEATHER_LON in the environment.
const HOME = { lat: Number(process.env.WEATHER_LAT), lon: Number(process.env.WEATHER_LON) };
export const weatherConfigured = () => Number.isFinite(HOME.lat) && Number.isFinite(HOME.lon) && !(HOME.lat === 0 && HOME.lon === 0);
const TZ = "America/Los_Angeles";

export interface HourWx {
  start: string; // ISO
  tempF: number;
  pop: number; // % chance of precipitation
  short: string; // "Mostly Sunny"
}

async function nws<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/geo+json" } });
  if (!r.ok) throw new Error(`weather service ${r.status}`);
  return (await r.json()) as T;
}

async function forecastUrls(): Promise<{ hourly: string; daily: string }> {
  if (!weatherConfigured()) throw new Error("weather isn't configured (set WEATHER_LAT and WEATHER_LON)");
  const cached = await redis.get<{ hourly: string; daily: string }>("wx_points").catch(() => null);
  if (cached) return cached;
  const p = await nws<{ properties: { forecast: string; forecastHourly: string } }>(`https://api.weather.gov/points/${HOME.lat},${HOME.lon}`);
  const urls = { hourly: p.properties.forecastHourly, daily: p.properties.forecast };
  await redis.set("wx_points", urls, { ex: 30 * 86400 }).catch(() => {});
  return urls;
}

export async function hourly(): Promise<HourWx[]> {
  const cached = await redis.get<HourWx[]>("wx_hourly").catch(() => null);
  if (cached) return cached;
  const { hourly: url } = await forecastUrls();
  const j = await nws<{ properties: { periods: { startTime: string; temperature: number; probabilityOfPrecipitation?: { value: number | null }; shortForecast: string }[] } }>(url);
  const out = j.properties.periods.map((p) => ({ start: p.startTime, tempF: p.temperature, pop: p.probabilityOfPrecipitation?.value ?? 0, short: p.shortForecast }));
  await redis.set("wx_hourly", out, { ex: 3600 }).catch(() => {});
  return out;
}

const wallDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const wallHour = (iso: string) => Number(new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }));

/** One line for a day: "Sunny, 58–74°F, rain 10%". Null beyond the forecast range. */
export async function dayOutlook(date: string): Promise<string | null> {
  const hrs = (await hourly()).filter((h) => wallDate(h.start) === date);
  if (!hrs.length) return null;
  const day = hrs.filter((h) => wallHour(h.start) >= 8 && wallHour(h.start) <= 19);
  const set = day.length ? day : hrs;
  const temps = set.map((h) => h.tempF);
  const pop = Math.max(...set.map((h) => h.pop));
  const counts = new Map<string, number>();
  for (const h of set) counts.set(h.short, (counts.get(h.short) || 0) + 1);
  const short = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return `${short}, ${Math.min(...temps)}–${Math.max(...temps)}°F${pop >= 20 ? `, rain ${pop}%` : ""}`;
}

/** Weather during a time window on a date (HH:mm, Pacific). Null if outside the forecast. */
export async function windowWeather(date: string, start: string, end?: string): Promise<{ pop: number; minF: number; maxF: number; short: string } | null> {
  const h0 = Number(start.slice(0, 2));
  const h1 = end ? Math.max(Number(end.slice(0, 2)), h0) : h0 + 1;
  const hrs = (await hourly()).filter((h) => wallDate(h.start) === date && wallHour(h.start) >= h0 && wallHour(h.start) <= h1);
  if (!hrs.length) return null;
  return {
    pop: Math.max(...hrs.map((h) => h.pop)),
    minF: Math.min(...hrs.map((h) => h.tempF)),
    maxF: Math.max(...hrs.map((h) => h.tempF)),
    short: hrs[0].short,
  };
}

const OUTDOOR_RE = /\b(soccer|baseball|softball|t-?ball|football|lacrosse|game|practice|field|park|picnic|hike|hiking|beach|pool|swim|playground|zoo|farm|fair|festival|parade|outdoor|garden|track|tennis|golf|bike|walk|5k|pumpkin|patch|trick.or.treat|carnival|camping|campout|bbq|barbecue|block party)\b/i;
const INDOOR_RE = /\b(zoom|virtual|online|indoor|gym|library|museum|theater|theatre|dentist|doctor|pediatric|clinic|mass|church|haircut)\b/i;

export function isOutdoor(e: Pick<CalEvent, "title" | "location">): boolean {
  const t = `${e.title} ${e.location || ""}`;
  return OUTDOOR_RE.test(t) && !INDOOR_RE.test(t);
}

/** A short weather note for an outdoor event, only when it matters (rain, heat, cold). */
export async function eventWeatherNote(e: Pick<CalEvent, "title" | "location" | "allDay">, date: string, start?: string, end?: string): Promise<string | null> {
  if (!isOutdoor(e)) return null;
  const w = e.allDay || !start ? await windowWeather(date, "09:00", "17:00") : await windowWeather(date, start, end);
  if (!w) return null;
  if (w.pop >= 30) return `☔ ${w.pop}% chance of rain`;
  if (w.maxF >= 90) return `🥵 up to ${w.maxF}°F`;
  if (w.minF <= 45) return `🧥 ${w.minF}°F`;
  return null;
}

// ── Anywhere else (a trip, a day out) ─────────────────────────────────────────

/** Coordinates for a US place name (OpenStreetMap; cached), or null. */
async function placePoint(place: string): Promise<{ lat: number; lon: number } | null> {
  const key = `wx_geo:${place.toLowerCase().trim().slice(0, 120)}`;
  const hit = await redis.get<{ lat: number; lon: number } | "none">(key).catch(() => null);
  if (hit) return hit === "none" ? null : hit;
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(place)}`, { headers: { "user-agent": UA } }).catch(() => null);
  const j = r?.ok ? ((await r.json().catch(() => [])) as { lat: string; lon: string }[]) : [];
  const pt = j[0] ? { lat: Math.round(Number(j[0].lat) * 1000) / 1000, lon: Math.round(Number(j[0].lon) * 1000) / 1000 } : null;
  await redis.set(key, pt || "none", { ex: pt ? 90 * 86400 : 7 * 86400 }).catch(() => {});
  return pt;
}

/** Daily outlook lines for a US place ("Asheville, NC"), from its own NWS forecast. Null if the place can't be found. */
export async function placeOutlook(place: string, date: string, days = 1): Promise<string[] | null> {
  const pt = await placePoint(place);
  if (!pt) return null;
  const key = `wx_hourly_at:${pt.lat},${pt.lon}`;
  let hrs = await redis.get<HourWx[]>(key).catch(() => null);
  if (!hrs) {
    const p = await nws<{ properties: { forecastHourly: string } }>(`https://api.weather.gov/points/${pt.lat},${pt.lon}`);
    const j = await nws<{ properties: { periods: { startTime: string; temperature: number; probabilityOfPrecipitation?: { value: number | null }; shortForecast: string }[] } }>(p.properties.forecastHourly);
    hrs = j.properties.periods.map((x) => ({ start: x.startTime, tempF: x.temperature, pop: x.probabilityOfPrecipitation?.value ?? 0, short: x.shortForecast }));
    await redis.set(key, hrs, { ex: 3600 }).catch(() => {});
  }
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(`${date}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    const day = hrs.filter((h) => wallDate(h.start) === d && wallHour(h.start) >= 8 && wallHour(h.start) <= 19);
    if (!day.length) { out.push(`${d}: beyond the ~7-day forecast`); continue; }
    const counts = new Map<string, number>();
    for (const h of day) counts.set(h.short, (counts.get(h.short) || 0) + 1);
    const pop = Math.max(...day.map((h) => h.pop));
    out.push(`${d}: ${[...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]}, ${Math.min(...day.map((h) => h.tempF))}–${Math.max(...day.map((h) => h.tempF))}°F${pop >= 20 ? `, rain ${pop}%` : ""}`);
  }
  return out;
}
