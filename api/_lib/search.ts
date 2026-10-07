import { randomBytes } from "node:crypto";
import { redis } from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Structured search (SerpApi: Google Flights, Google Hotels, Google Maps). Seconds instead of a
// browser task's minutes, and compact rows instead of whole pages. Read-only: booking still
// happens on the airline's / hotel's own site (a browser task, with approval).
// ─────────────────────────────────────────────────────────────────────────────

export const searchConfigured = (): boolean => !!process.env.SERPAPI_API_KEY;
const NOT_SET_UP = "Flight/hotel/place search isn't set up (SERPAPI_API_KEY is missing — see Kimi tab → Setup). Use web_search for now, and mention it to the parent.";

async function serp(params: Record<string, string | number | undefined>): Promise<any> {
  const q = new URLSearchParams({ api_key: process.env.SERPAPI_API_KEY!, hl: "en", gl: "us" });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const r = await fetch(`https://serpapi.com/search.json?${q}`, { signal: AbortSignal.timeout(45_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `SerpApi ${r.status}`);
  return j;
}

// Google's next-step tokens are hundreds of characters; Kimi gets a short handle instead.
async function handle(token: string): Promise<string> {
  const id = `t${randomBytes(3).toString("hex")}`;
  await redis.set(`serp_tok:${id}`, token, { ex: 3 * 86400 });
  return id;
}
async function token(h: string): Promise<string | null> {
  return /^t[0-9a-f]{6}$/.test(h) ? ((await redis.get<string>(`serp_tok:${h}`)) ?? null) : null;
}

const hm = (t?: string) => (t || "").replace(/^\d{4}-\d{2}-\d{2} /, "");
const dur = (m?: number) => (m ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : "");

export interface FlightQuery {
  from: string;
  to: string;
  date: string;
  returnDate?: string;
  adults?: number;
  children?: number;
  cabin?: "economy" | "premium_economy" | "business" | "first";
  nonstop?: boolean;
  airlines?: string[];
  maxPrice?: number;
  /** A handle from an earlier result: the return flights for that outbound, or its booking options. */
  next?: string;
}

const CABIN = { economy: 1, premium_economy: 2, business: 3, first: 4 } as const;

export async function searchFlights(q: FlightQuery): Promise<string> {
  if (!searchConfigured()) return NOT_SET_UP;
  const iata = (s: string) => s.trim().toUpperCase();
  if (!/^[A-Z]{3}(,[A-Z]{3})*$/.test(iata(q.from)) || !/^[A-Z]{3}(,[A-Z]{3})*$/.test(iata(q.to))) return "error: from and to must be airport codes (e.g. JFK, or JFK,LGA,EWR)";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date) || (q.returnDate && !/^\d{4}-\d{2}-\d{2}$/.test(q.returnDate))) return "error: dates must be YYYY-MM-DD";
  const base = {
    engine: "google_flights",
    departure_id: iata(q.from),
    arrival_id: iata(q.to),
    outbound_date: q.date,
    return_date: q.returnDate,
    type: q.returnDate ? 1 : 2,
    adults: q.adults || 1,
    children: q.children || 0,
    travel_class: CABIN[q.cabin || "economy"],
    stops: q.nonstop ? 1 : 0,
    include_airlines: q.airlines?.length ? q.airlines.map((a) => a.trim().toUpperCase()).join(",") : undefined,
    max_price: q.maxPrice,
    currency: "USD",
  };
  const next = q.next ? await token(q.next) : null;
  if (q.next && !next) return "error: that option has expired — search again";
  const isBooking = !!next && q.next && (await redis.get<string>(`serp_kind:${q.next}`)) === "booking";
  const j = await serp(next ? { ...base, ...(isBooking ? { booking_token: next } : { departure_token: next }) } : base);

  if (isBooking) {
    const opts = (j.booking_options || []).slice(0, 6).map((o: any) => {
      const t = o.together || o.departing || {};
      return `• ${t.book_with || "?"}: $${t.price ?? "?"}${t.option_title ? ` (${t.option_title})` : ""}${t.baggage_prices?.length ? ` · bags: ${t.baggage_prices.join("; ")}` : ""}`;
    });
    return opts.length ? `Where to book:\n${opts.join("\n")}` : "No booking options returned.";
  }

  const rows = [...(j.best_flights || []), ...(j.other_flights || [])].slice(0, 10);
  if (!rows.length) return "No flights found for that search.";
  const out: string[] = [];
  const leg = q.returnDate && next ? "Return flights" : q.returnDate ? "Outbound flights (price is the round-trip total)" : "Flights";
  const [a, b] = q.returnDate && next ? [base.arrival_id, base.departure_id] : [base.departure_id, base.arrival_id];
  out.push(`${leg} ${a}→${b} on ${q.returnDate && next ? q.returnDate : q.date}, ${base.adults} adult${base.adults > 1 ? "s" : ""}${base.children ? ` + ${base.children} child${base.children > 1 ? "ren" : ""}` : ""}${q.cabin && q.cabin !== "economy" ? `, ${q.cabin}` : ""}:`);
  for (const r of rows) {
    const f = r.flights || [];
    const first = f[0] || {};
    const last = f[f.length - 1] || {};
    const nums = f.map((x: any) => x.flight_number).filter(Boolean).join("+");
    const via = (r.layovers || []).map((l: any) => `${l.id} ${dur(l.duration)}${l.overnight ? " overnight" : ""}`).join(", ");
    const extra = [first.travel_class && first.travel_class !== "Economy" ? first.travel_class : "", first.airplane, first.legroom, (first.extensions || []).find((e: string) => /wi-?fi|power|seat/i.test(e))].filter(Boolean).join(", ");
    const tok = r.departure_token || r.booking_token;
    let h = "";
    if (tok) {
      h = await handle(tok);
      if (r.booking_token && !r.departure_token) await redis.set(`serp_kind:${h}`, "booking", { ex: 3 * 86400 });
    }
    out.push(
      `• $${r.price ?? "?"} — ${[...new Set(f.map((x: any) => x.airline))].join("/")} ${nums}: ${first.departure_airport?.id} ${hm(first.departure_airport?.time)} → ${last.arrival_airport?.id} ${hm(last.arrival_airport?.time)}` +
        ` (${dur(r.total_duration)}${via ? `, via ${via}` : ", nonstop"})${extra ? ` · ${extra}` : ""}${h ? ` · [${h}${r.departure_token ? ": see returns" : ": where to book"}]` : ""}`
    );
  }
  const pi = j.price_insights;
  if (pi?.lowest_price) out.push(`Price level: ${pi.price_level || "?"} (typical $${(pi.typical_price_range || []).join("–$")}).`);
  out.push("Pass a [handle] back as next to see return flights or where to book. Fares are Google Flights' and can change; confirm on the airline's site before booking.");
  return out.join("\n");
}

export async function searchHotels(q: { where: string; checkIn: string; checkOut: string; adults?: number; childAges?: number[]; maxPrice?: number; sort?: "price" | "rating" }): Promise<string> {
  if (!searchConfigured()) return NOT_SET_UP;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(q.checkOut)) return "error: dates must be YYYY-MM-DD";
  const j = await serp({
    engine: "google_hotels",
    q: q.where,
    check_in_date: q.checkIn,
    check_out_date: q.checkOut,
    adults: q.adults || 2,
    children: q.childAges?.length || 0,
    children_ages: q.childAges?.length ? q.childAges.map((n) => Math.max(1, Math.min(17, Math.round(n)))).join(",") : undefined,
    max_price: q.maxPrice,
    sort_by: q.sort === "price" ? 3 : q.sort === "rating" ? 8 : undefined,
    currency: "USD",
  });
  const props = (j.properties || []).slice(0, 10);
  if (!props.length) return "No hotels found.";
  const lines = props.map(
    (p: any) =>
      `• ${p.name}${p.hotel_class ? ` (${p.hotel_class})` : ""} — ${p.rate_per_night?.lowest ? `${p.rate_per_night.lowest}/night${p.total_rate?.lowest ? `, ${p.total_rate.lowest} total` : ""}` : "no rate listed"} · ${p.overall_rating ? `${p.overall_rating}★ (${p.reviews} reviews)` : "no rating"}` +
      `${p.amenities?.length ? ` · ${p.amenities.slice(0, 5).join(", ")}` : ""}${p.link ? ` · ${p.link}` : ""}`
  );
  // Google lists no rates when the whole party can't share one room (e.g. 2 adults + 3 kids).
  const guests = (q.adults || 2) + (q.childAges?.length || 0);
  if (props.every((p: any) => !p.rate_per_night?.lowest) && guests > 4)
    lines.push(`No rates listed: Google prices one room, and ${guests} guests don't fit one. Search again per room (e.g. 2 adults + 1 child) to see prices, and book two rooms or a suite.`);
  return lines.join("\n");
}

export async function searchPlaces(q: { query: string; near?: string }): Promise<string> {
  if (!searchConfigured()) return NOT_SET_UP;
  const j = await serp({ engine: "google_maps", type: "search", q: q.near ? `${q.query} near ${q.near}` : q.query });
  const rows = (j.local_results || (j.place_results ? [j.place_results] : [])).slice(0, 8);
  if (!rows.length) return "No places found.";
  return rows
    .map((p: any) => {
      const hours = p.open_state || (p.operating_hours ? Object.entries(p.operating_hours).map(([d, h]) => `${d.slice(0, 3)} ${h}`).join(", ") : "");
      return `• ${p.title}${p.type ? ` (${p.type})` : ""} — ${p.address || ""}${p.phone ? ` · ${p.phone}` : ""}${p.rating ? ` · ${p.rating}★ (${p.reviews})` : ""}${hours ? ` · ${hours}` : ""}${p.website ? ` · ${p.website}` : ""}`;
    })
    .join("\n");
}
