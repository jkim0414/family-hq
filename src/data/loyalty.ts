import type { LoyaltyAccount } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Loyalty programs a travel card can hold. Numbers are normalized (uppercase, no spaces or
// dashes) and must be plausible (letters/digits, 4–20 long) to save. Each program's usual shape
// is a soft check: a number that doesn't match gets a warning ("usually 10 digits"), not a
// refusal — formats change and older accounts differ. Shared by the API and the app.
// ─────────────────────────────────────────────────────────────────────────────

export interface LoyaltyProgram {
  id: string;
  name: string;
  kind: "airline" | "hotel" | "car" | "rail";
  aliases: string[];
  /** The usual shape of a member number (soft). */
  usual?: RegExp;
  hint?: string;
}

export const LOYALTY_PROGRAMS: LoyaltyProgram[] = [
  { id: "aircanada", name: "Air Canada Aeroplan", kind: "airline", aliases: ["aeroplan", "air canada"], usual: /^\d{9}$/, hint: "9 digits" },
  { id: "flyingblue", name: "Air France-KLM Flying Blue", kind: "airline", aliases: ["flying blue", "air france", "klm"], usual: /^\d{10}$/, hint: "10 digits" },
  { id: "alaska", name: "Alaska Atmos Rewards", kind: "airline", aliases: ["alaska", "alaska mileage plan", "mileage plan", "atmos", "hawaiian", "hawaiianmiles"], usual: /^\d{6,10}$/, hint: "digits only" },
  { id: "american", name: "American Airlines AAdvantage", kind: "airline", aliases: ["american", "aadvantage", "aa", "american airlines"], usual: /^[A-Z0-9]{7}$/, hint: "7 letters and digits" },
  { id: "britishairways", name: "British Airways Club", kind: "airline", aliases: ["british airways", "ba", "avios", "executive club", "british airways executive club"], usual: /^\d{8,9}$/, hint: "digits only" },
  { id: "delta", name: "Delta SkyMiles", kind: "airline", aliases: ["delta", "skymiles", "sky miles"], usual: /^\d{10}$/, hint: "10 digits" },
  { id: "emirates", name: "Emirates Skywards", kind: "airline", aliases: ["skywards", "emirates"], usual: /^(EK)?\d{9}$/, hint: "9 digits" },
  { id: "jetblue", name: "JetBlue TrueBlue", kind: "airline", aliases: ["jetblue", "trueblue", "true blue"], usual: /^\d{9,11}$/, hint: "digits only" },
  { id: "korean", name: "Korean Air SKYPASS", kind: "airline", aliases: ["korean air", "skypass", "sky pass"], usual: /^\d{12}$/, hint: "12 digits" },
  { id: "lufthansa", name: "Lufthansa Miles & More", kind: "airline", aliases: ["miles & more", "miles and more", "lufthansa"], usual: /^\d{15}$/, hint: "15 digits" },
  { id: "singapore", name: "Singapore KrisFlyer", kind: "airline", aliases: ["krisflyer", "singapore airlines"], usual: /^\d{10}$/, hint: "10 digits" },
  { id: "southwest", name: "Southwest Rapid Rewards", kind: "airline", aliases: ["southwest", "rapid rewards"], usual: /^\d{8,12}$/, hint: "digits only" },
  { id: "united", name: "United MileagePlus", kind: "airline", aliases: ["united", "mileageplus", "mileage plus", "ua"], usual: /^(?=.{8}$)[A-Z]{2,3}\d{5,6}$/, hint: "8 characters, like AB123456" },
  { id: "virgin", name: "Virgin Atlantic Flying Club", kind: "airline", aliases: ["flying club", "virgin atlantic"], usual: /^\d{8,10}$/, hint: "digits only" },
  { id: "marriott", name: "Marriott Bonvoy", kind: "hotel", aliases: ["marriott", "bonvoy"], usual: /^\d{9}$/, hint: "9 digits" },
  { id: "hilton", name: "Hilton Honors", kind: "hotel", aliases: ["hilton", "hhonors", "honors"], usual: /^\d{9,10}$/, hint: "9–10 digits" },
  { id: "hyatt", name: "World of Hyatt", kind: "hotel", aliases: ["hyatt", "world of hyatt"], usual: /^\d{8,9}[A-Z]?$/, hint: "9 digits, sometimes ending in a letter" },
  { id: "ihg", name: "IHG One Rewards", kind: "hotel", aliases: ["ihg", "ihg rewards", "ihg one", "holiday inn"], usual: /^\d{9,10}$/, hint: "9–10 digits" },
  { id: "national", name: "National Emerald Club", kind: "car", aliases: ["national", "emerald club"], usual: /^\d{8,9}$/, hint: "digits only" },
  { id: "hertz", name: "Hertz Gold Plus Rewards", kind: "car", aliases: ["hertz", "gold plus", "hertz gold"], usual: /^\d{6,9}$/, hint: "digits only" },
  { id: "avis", name: "Avis Preferred", kind: "car", aliases: ["avis", "avis preferred"], usual: /^[A-Z0-9]{6}$/, hint: "6 letters and digits" },
  { id: "amtrak", name: "Amtrak Guest Rewards", kind: "rail", aliases: ["amtrak", "guest rewards"], usual: /^\d{10}$/, hint: "10 digits" },
];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The known program a name refers to ("SkyMiles", "delta" → Delta SkyMiles). */
export function findProgram(name: string): LoyaltyProgram | undefined {
  const k = squash(name);
  if (!k) return undefined;
  return LOYALTY_PROGRAMS.find((p) => squash(p.name) === k || p.id === k || p.aliases.some((a) => squash(a) === k));
}

export const normalizeLoyaltyNumber = (n: string) => n.toUpperCase().replace(/[\s\-–.#]/g, "");

/** Hard check: an error, or null when the number can be saved. */
export function loyaltyError(a: { program: string; number: string }): string | null {
  if (!a.program.trim()) return "Pick a program";
  const n = normalizeLoyaltyNumber(a.number);
  if (!n) return "Enter the member number";
  if (!/^[A-Z0-9]{4,20}$/.test(n)) return "Letters and digits only, 4–20 characters";
  return null;
}

/** Soft check: a note when the number doesn't look like the program's usual format. */
export function loyaltyWarning(a: { program: string; number: string }): string | null {
  const p = findProgram(a.program);
  const n = normalizeLoyaltyNumber(a.number);
  if (!p?.usual || !n || p.usual.test(n)) return null;
  return `${p.name} numbers are usually ${p.hint} — double-check it`;
}

/** Canonical name and normalized number; drops rows that can't be saved. */
export function cleanLoyalty(xs: LoyaltyAccount[]): LoyaltyAccount[] {
  const out: LoyaltyAccount[] = [];
  for (const x of xs || []) {
    const program = (findProgram(x?.program || "")?.name || String(x?.program || "").trim()).slice(0, 60);
    const number = normalizeLoyaltyNumber(String(x?.number || "")).slice(0, 20);
    if (loyaltyError({ program, number })) continue;
    const i = out.findIndex((y) => squash(y.program) === squash(program));
    if (i >= 0) out[i] = { program, number };
    else out.push({ program, number });
  }
  return out;
}
