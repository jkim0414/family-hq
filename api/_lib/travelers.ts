import { redis } from "./db.js";
import { encrypt, decrypt, vaultConfigured, type VaultEntry } from "./vault.js";
import { isParent } from "./privacy.js";
import { PEOPLE, personName } from "../../src/data/people.js";
import { cleanLoyalty, loyaltyError, loyaltyWarning } from "../../src/data/loyalty.js";
import type { LoyaltyAccount, Member, Traveler } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Travel cards: each family member's legal name, date of birth, seat preference, loyalty
// numbers, and (encrypted with VAULT_KEY) passport and Known Traveler numbers. A parent sees
// and edits everyone's; a caregiver only her own. Kimi reads the cards with secrets masked
// and fills a passport/KTN into a booking page without seeing it (browse_fill_travel_doc).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "travelers";
type Enc = VaultEntry["enc"];
interface Stored extends Traveler {
  ktnEnc?: Enc;
  passportEnc?: Enc;
}

/** Everyone who can have a travel card: the family roster (parents, Grandma, kids). */
export const TRAVELER_IDS = PEOPLE.map((p) => p.id);

/** Whose cards a member may see and edit: a parent, everyone's; anyone else, their own. */
export function travelersFor(viewer: Member): string[] {
  return isParent(viewer) ? [...TRAVELER_IDS] : TRAVELER_IDS.filter((id) => id === viewer);
}

function publicView(id: string, s: Stored | null | undefined): Traveler {
  const { ktnEnc: _k, passportEnc: _p, ...rest } = s || ({} as Stored);
  return { ...rest, id, loyalty: rest.loyalty || [] };
}

async function getStored(id: string): Promise<Stored | null> {
  return ((await redis.hget<Stored>(KEY, id)) as Stored | null) ?? null;
}

export async function listTravelers(viewer: Member): Promise<Traveler[]> {
  const ids = travelersFor(viewer);
  const all = ((await redis.hgetall<Record<string, Stored>>(KEY)) || {}) as Record<string, Stored>;
  return ids.map((id) => publicView(id, all[id]));
}

const clean = (v: unknown, max = 80) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const last4 = (v: string) => v.replace(/\s/g, "").slice(-4);

export interface TravelerPatch {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  dob?: string;
  gender?: string;
  seat?: string;
  notes?: string;
  /** Replaces the whole list. */
  loyalty?: LoyaltyAccount[];
  /** Adds or updates one program's number (Kimi's save_traveler_info). */
  addLoyalty?: LoyaltyAccount;
  /** A new number to store (encrypted); null clears it. */
  ktn?: string | null;
  passportNumber?: string | null;
  passportCountry?: string;
  passportExpires?: string;
}

/** Save part of a card. Throws on a field that doesn't validate. */
export async function saveTraveler(viewer: Member, id: string, patch: TravelerPatch): Promise<Traveler> {
  if (!travelersFor(viewer).includes(id)) throw new Error("not yours to edit");
  const cur: Stored = (await getStored(id)) || { id, loyalty: [] };
  const next: Stored = { ...cur, id, loyalty: cur.loyalty || [] };
  for (const k of ["firstName", "middleName", "lastName", "notes"] as const) {
    if (patch[k] !== undefined) next[k] = clean(patch[k], k === "notes" ? 300 : 80) || undefined;
  }
  if (patch.dob !== undefined) {
    if (patch.dob && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dob)) throw new Error("date of birth must be YYYY-MM-DD");
    next.dob = patch.dob || undefined;
  }
  if (patch.gender !== undefined) {
    if (patch.gender && !["M", "F", "X"].includes(patch.gender)) throw new Error("gender must be M, F, or X");
    next.gender = (patch.gender || undefined) as Traveler["gender"];
  }
  if (patch.seat !== undefined) {
    if (patch.seat && !["window", "aisle", "any"].includes(patch.seat)) throw new Error("seat must be window, aisle, or any");
    next.seat = (patch.seat || undefined) as Traveler["seat"];
  }
  // Loyalty numbers: a known program's canonical name, the number normalized; a malformed one is refused.
  const check = (xs: LoyaltyAccount[]) => {
    for (const x of xs) {
      const err = loyaltyError({ program: String(x?.program || ""), number: String(x?.number || "") });
      if (err) throw new Error(`${x?.program || "Loyalty number"}: ${err}`);
    }
  };
  if (patch.loyalty) {
    const rows = patch.loyalty.filter((x) => x && (String(x.program || "").trim() || String(x.number || "").trim()));
    check(rows);
    next.loyalty = cleanLoyalty(rows);
  }
  if (patch.addLoyalty) {
    check([patch.addLoyalty]);
    next.loyalty = cleanLoyalty([...next.loyalty, patch.addLoyalty]);
  }
  if (patch.ktn !== undefined || patch.passportNumber !== undefined) {
    if (!vaultConfigured()) throw new Error("the vault isn't set up (VAULT_KEY), so passport and Known Traveler numbers can't be stored");
  }
  if (patch.ktn !== undefined) {
    const v = (patch.ktn || "").replace(/\s/g, "");
    if (v && !/^[A-Za-z0-9]{8,15}$/.test(v)) throw new Error("a Known Traveler Number is 8–15 letters and digits");
    next.ktnEnc = v ? encrypt(v) : undefined;
    next.ktn = v ? { last4: last4(v) } : undefined;
  }
  if (patch.passportNumber !== undefined) {
    const v = (patch.passportNumber || "").replace(/\s/g, "");
    if (v && !/^[A-Za-z0-9]{6,12}$/.test(v)) throw new Error("a passport number is 6–12 letters and digits");
    next.passportEnc = v ? encrypt(v) : undefined;
    next.passport = v ? { ...(next.passport || {}), last4: last4(v) } : undefined;
  }
  if (next.passport && (patch.passportCountry !== undefined || patch.passportExpires !== undefined)) {
    if (patch.passportExpires && !/^\d{4}-\d{2}-\d{2}$/.test(patch.passportExpires)) throw new Error("passport expiry must be YYYY-MM-DD");
    if (patch.passportCountry !== undefined) next.passport.country = clean(patch.passportCountry, 40) || undefined;
    if (patch.passportExpires !== undefined) next.passport.expires = patch.passportExpires || undefined;
  }
  next.updatedAt = new Date().toISOString();
  await redis.hset(KEY, { [id]: next });
  return publicView(id, next);
}

/** The full passport or Known Traveler number, for filling a page (never shown to the model). */
export async function travelSecret(id: string, field: "ktn" | "passport"): Promise<string | null> {
  const s = await getStored(id);
  const enc = field === "ktn" ? s?.ktnEnc : s?.passportEnc;
  return enc ? decrypt(enc) : null;
}

/** Cards as Kimi sees them: everything but the passport and KTN, which show as last four. */
export function travelersText(ts: Traveler[]): string {
  const lines = ts.map((t) => {
    const name = [t.firstName, t.middleName, t.lastName].filter(Boolean).join(" ");
    const bits = [
      name ? `legal name ${name}` : "legal name not on file",
      t.dob ? `born ${t.dob}` : "",
      t.gender ? `gender ${t.gender}` : "",
      t.seat && t.seat !== "any" ? `prefers ${t.seat}` : "",
      t.loyalty.length ? `loyalty: ${t.loyalty.map((l) => `${l.program} ${l.number}${loyaltyWarning(l) ? " (format looks off — confirm before using)" : ""}`).join("; ")}` : "",
      t.ktn ? `Known Traveler # on file (…${t.ktn.last4})` : "",
      t.passport ? `passport on file (…${t.passport.last4}${t.passport.country ? `, ${t.passport.country}` : ""}${t.passport.expires ? `, expires ${t.passport.expires}` : ""})` : "",
      t.notes ? `notes: ${t.notes}` : "",
    ].filter(Boolean);
    return `• ${personName(t.id)} (id "${t.id}"): ${bits.join(" · ")}`;
  });
  return lines.join("\n");
}
