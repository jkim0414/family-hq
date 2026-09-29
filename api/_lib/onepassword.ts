import type { Client, Item } from "@1password/sdk";
import { redis } from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1Password as the vault of record. A read-only service account scoped to ONE
// vault (OP_VAULT, default "Family HQ") lets the browser agent look up logins on
// demand — nothing is copied into the app, and a password changed in 1Password
// is live immediately. Secrets are only ever read server-side at fill time.
// ─────────────────────────────────────────────────────────────────────────────

export function opConfigured(): boolean {
  return !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
}

export function opVaultName(): string {
  return process.env.OP_VAULT || "Family HQ";
}

export interface OpLogin {
  id: string;
  title: string;
  site: string;
  username: string;
  hasOtp: boolean;
}

// The SDK loads a WASM core at import time; import it lazily so a packaging
// problem can only break 1Password calls, never the whole API function.
let clientP: Promise<Client> | null = null;
function client(): Promise<Client> {
  if (!clientP) {
    clientP = import("@1password/sdk").then(({ createClient }) => createClient({
      auth: process.env.OP_SERVICE_ACCOUNT_TOKEN!,
      integrationName: "Family HQ",
      integrationVersion: "v1.0.0",
    })).catch((e) => {
      clientP = null;
      throw e;
    });
  }
  return clientP;
}

let vaultIdP: Promise<string> | null = null;
async function vaultId(): Promise<string> {
  if (!vaultIdP) {
    vaultIdP = (async () => {
      const want = opVaultName().trim().toLowerCase();
      const vaults = await (await client()).vaults.list();
      const v = vaults.find((x) => x.title.trim().toLowerCase() === want || x.id === process.env.OP_VAULT);
      if (!v) throw new Error(`1Password vault "${opVaultName()}" not found (service account can see: ${vaults.map((x) => x.title).join(", ") || "none"})`);
      return v.id;
    })().catch((e) => {
      vaultIdP = null;
      throw e;
    });
  }
  return vaultIdP;
}

const host = (url: string) => {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return url;
  }
};

function pick(item: Item, field: "username" | "password" | "otp"): string | null {
  const f = item.fields;
  if (field === "username") {
    const u = f.find((x) => x.id === "username") || f.find((x) => x.fieldType === ("Email" as Item["fields"][number]["fieldType"])) || f.find((x) => x.fieldType === ("Text" as Item["fields"][number]["fieldType"]) && /user|email|login/i.test(x.title));
    return u?.value || null;
  }
  if (field === "password") {
    const p = f.find((x) => x.id === "password") || f.find((x) => x.fieldType === ("Concealed" as Item["fields"][number]["fieldType"]));
    return p?.value || null;
  }
  const t = f.find((x) => x.fieldType === ("Totp" as Item["fields"][number]["fieldType"]));
  const d = t?.details;
  return d && d.type === "Otp" ? d.content.code || null : null;
}

const CACHE_KEY = "op_logins_cache"; // fresh list (1h)
const STALE_KEY = "op_logins_last"; // last good list, kept forever as a fallback
const CACHE_S = 60 * 60;
const USER_TTL_S = 14 * 86400; // usernames rarely change
const MAX_ITEM_FETCHES = 8; // per list call — bounds API usage; the rest fill in on later calls

// 1Password service accounts are rate-limited (hundreds of reads/hour). A list
// is ONE call; usernames need one fetch per item, so they're cached per item
// for two weeks and only a handful of missing ones are fetched per call.
const BACKOFF_KEY = "op_backoff_until";
const BACKOFF_S = 20 * 60; // after a rate-limit error, don't touch the API for a while

export async function listOpLogins(): Promise<OpLogin[]> {
  const cached = await redis.get<OpLogin[]>(CACHE_KEY).catch(() => null);
  if (cached) return cached;
  // Backing off after a rate-limit error: serve the last good list, or fail fast
  // without spending another request.
  if (await redis.get(BACKOFF_KEY).catch(() => null)) {
    const stale = await redis.get<OpLogin[]>(STALE_KEY).catch(() => null);
    if (stale) return stale;
    throw new Error("1Password rate limit — backing off; try again in a few minutes");
  }
  try {
    const c = await client();
    const vid = await vaultId();
    const overviews = (await c.items.list(vid)).filter((o) => (o.category as string) === "Login" || (o.category as string) === "Password");
    const userKeys = overviews.map((o) => `op_user:${o.id}`);
    const known = userKeys.length ? await redis.mget<(string | null)[]>(...userKeys).catch(() => userKeys.map(() => null)) : [];
    const out: OpLogin[] = [];
    let fetched = 0;
    for (let i = 0; i < overviews.length; i++) {
      const o = overviews[i];
      let username = known[i] ?? "";
      let hasOtp = false;
      const cachedOtp = await redis.get<string>(`op_otp:${o.id}`).catch(() => null);
      if (cachedOtp != null) hasOtp = cachedOtp === "1";
      if ((known[i] == null || cachedOtp == null) && fetched < MAX_ITEM_FETCHES) {
        fetched++;
        const item = await c.items.get(vid, o.id).catch(() => null);
        if (item) {
          username = pick(item, "username") || "";
          hasOtp = item.fields.some((x) => x.fieldType === ("Totp" as Item["fields"][number]["fieldType"]));
          await redis.set(`op_user:${o.id}`, username, { ex: USER_TTL_S }).catch(() => {});
          await redis.set(`op_otp:${o.id}`, hasOtp ? "1" : "0", { ex: USER_TTL_S }).catch(() => {});
        }
      }
      out.push({ id: o.id, title: o.title, site: o.websites?.[0]?.url ? host(o.websites[0].url) : "", username, hasOtp });
    }
    out.sort((a, b) => a.title.localeCompare(b.title));
    // Cache briefly only if every username is known; otherwise let the next
    // call fetch a few more (still one list call each time).
    const complete = out.every((l, i) => known[i] != null || l.username) ;
    await redis.set(CACHE_KEY, out, { ex: complete ? CACHE_S : 60 }).catch(() => {});
    await redis.set(STALE_KEY, out).catch(() => {});
    return out;
  } catch (e) {
    if (/rate limit/i.test(String((e as Error).message || e))) await redis.set(BACKOFF_KEY, "1", { ex: BACKOFF_S }).catch(() => {});
    const stale = await redis.get<OpLogin[]>(STALE_KEY).catch(() => null);
    if (stale) {
      console.error("1Password list failed; serving last good list", String((e as Error).message || e).slice(0, 120));
      return stale;
    }
    throw e;
  }
}

export async function invalidateOpCache(): Promise<void> {
  await redis.del(CACHE_KEY).catch(() => {}); // usernames stay cached; only the list is re-read
}

/** Server-side only. Resolves a login by title (case-insensitive), site, or item id and returns one field's plaintext. */
export async function getOpField(name: string, field: "username" | "password" | "otp"): Promise<string | null> {
  const want = name.trim().toLowerCase();
  const logins = await listOpLogins();
  const match = logins.find((l) => l.title.toLowerCase() === want) || logins.find((l) => l.id === name) || logins.find((l) => l.site && l.site.toLowerCase() === want) || logins.find((l) => l.title.toLowerCase().includes(want));
  if (!match) return null;
  try {
    const item = await (await client()).items.get(await vaultId(), match.id);
    return pick(item, field);
  } catch (e) {
    if (/rate limit/i.test(String((e as Error).message || e))) await redis.set(BACKOFF_KEY, "1", { ex: BACKOFF_S }).catch(() => {});
    throw e;
  }
}

// ── Payment cards ────────────────────────────────────────────────────────────
// Cards in the same vault. The model only ever sees a card's title, brand, and
// last four digits; the full number, expiry, and security code are read here at
// fill time and typed straight into the checkout form.

export interface OpCard {
  id: string;
  title: string;
  brand: string;
  last4: string;
  /** A company card (Ramp, Brex, "business"…): never used unless a parent names it. */
  business: boolean;
}

export interface OpCardSecret {
  title: string;
  number: string;
  expMonth: string; // "MM"
  expYear: string; // "YYYY"
  cvc: string;
  name: string;
  zip: string | null;
  last4: string;
  brand: string;
}

export const BUSINESS_CARD_RE = /\b(ramp|brex|divvy|corporate|business|company|work|expensify|mercury|airbase)\b/i;
const CARDS_KEY = "op_cards_cache";
const CARD_META_TTL_S = 30 * 86400;

function field(item: Item, id: string) {
  return item.fields.find((f) => f.id === id);
}

function cardSecret(item: Item): OpCardSecret | null {
  const number = String(field(item, "ccnum")?.value || "").replace(/\D/g, "");
  if (number.length < 12) return null;
  const exp = String(field(item, "expiry")?.value || "");
  const m = exp.match(/^(\d{1,2})\/(\d{2,4})$/) || exp.match(/^(\d{4})(\d{2})$/);
  let expMonth = "";
  let expYear = "";
  if (m && exp.includes("/")) {
    expMonth = m[1].padStart(2, "0");
    expYear = m[2].length === 2 ? `20${m[2]}` : m[2];
  } else if (m) {
    expYear = m[1];
    expMonth = m[2];
  }
  const addr = item.fields.find((f) => f.fieldType === ("Address" as Item["fields"][number]["fieldType"]));
  const d = addr?.details as { type?: string; content?: { zip?: string } } | undefined;
  const zip = (d?.type === "Address" && d.content?.zip) || String(addr?.value || "").match(/\b\d{5}\b/)?.[0] || null;
  return {
    title: item.title,
    number,
    expMonth,
    expYear,
    cvc: String(field(item, "cvv")?.value || ""),
    name: String(field(item, "cardholder")?.value || ""),
    zip,
    last4: number.slice(-4),
    brand: String(field(item, "type")?.value || ""),
  };
}

/** Cards Kimi may pay with: title, brand, last four. One list call; metadata cached per card. */
export async function listOpCards(): Promise<OpCard[]> {
  const cached = await redis.get<OpCard[]>(CARDS_KEY).catch(() => null);
  if (cached) return cached;
  if (await redis.get(BACKOFF_KEY).catch(() => null)) throw new Error("1Password rate limit — backing off; try again in a few minutes");
  try {
    const c = await client();
    const vid = await vaultId();
    const overviews = (await c.items.list(vid)).filter((o) => (o.category as string) === "CreditCard");
    const out: OpCard[] = [];
    for (const o of overviews) {
      let meta = await redis.get<{ brand: string; last4: string }>(`op_card:${o.id}`).catch(() => null);
      if (!meta) {
        const item = await c.items.get(vid, o.id).catch(() => null);
        const s = item ? cardSecret(item) : null;
        meta = { brand: s?.brand || "", last4: s?.last4 || "" };
        await redis.set(`op_card:${o.id}`, meta, { ex: CARD_META_TTL_S }).catch(() => {});
      }
      out.push({ id: o.id, title: o.title, brand: meta.brand, last4: meta.last4, business: BUSINESS_CARD_RE.test(o.title) });
    }
    out.sort((a, b) => a.title.localeCompare(b.title));
    await redis.set(CARDS_KEY, out, { ex: CACHE_S }).catch(() => {});
    return out;
  } catch (e) {
    if (/rate limit/i.test(String((e as Error).message || e))) await redis.set(BACKOFF_KEY, "1", { ex: BACKOFF_S }).catch(() => {});
    throw e;
  }
}

/** Server-side only: resolve a card by title (or last four) and return what a checkout form needs. */
export async function getOpCard(name: string): Promise<OpCardSecret | null> {
  const want = name.trim().toLowerCase();
  const cards = await listOpCards();
  const match =
    cards.find((c) => c.title.toLowerCase() === want) ||
    cards.find((c) => c.last4 && want.includes(c.last4)) ||
    cards.find((c) => c.title.toLowerCase().includes(want) || want.includes(c.title.toLowerCase()));
  if (!match) return null;
  try {
    const item = await (await client()).items.get(await vaultId(), match.id);
    return cardSecret(item);
  } catch (e) {
    if (/rate limit/i.test(String((e as Error).message || e))) await redis.set(BACKOFF_KEY, "1", { ex: BACKOFF_S }).catch(() => {});
    throw e;
  }
}
