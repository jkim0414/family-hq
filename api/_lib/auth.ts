import { randomBytes, randomInt, createHash } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { redis } from "./db.js";
import { CONFIG } from "../../src/data/config.js";
import type { Member } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Magic-link auth with long-lived device sessions. The app is a household
// tool: only the household's emails can log in (parents, and a caregiver), a login link is valid
// for 15 minutes, and a successful login sets an httpOnly cookie that lasts
// ~6 months so each phone logs in once.
// ─────────────────────────────────────────────────────────────────────────────

export interface User {
  email: string;
  id: Member;
  name: string;
  role: "parent" | "caregiver";
}

// Everyone who can sign in: the parents, and a caregiver once her email is set in config.
const PARENTS: User[] = [
  { email: CONFIG.parents.alex.email.toLowerCase(), id: "alex", name: "Alex", role: "parent" },
  { email: CONFIG.parents.sam.email.toLowerCase(), id: "sam", name: "Sam", role: "parent" },
  ...(CONFIG.caregivers.grandma.email ? [{ email: CONFIG.caregivers.grandma.email.toLowerCase(), id: "grandma" as const, name: CONFIG.caregivers.grandma.callMe, role: "caregiver" as const }] : []),
];

const COOKIE = "fhq_session";
const SESSION_TTL_S = 180 * 24 * 3600; // ~6 months
const LOGIN_TTL_S = 15 * 60;

export function userForEmail(email: string): User | null {
  return PARENTS.find((p) => p.email === email.trim().toLowerCase()) || null;
}

export function userById(id: string): User | null {
  return PARENTS.find((p) => p.id === id) || null;
}

/** Create a one-time login token for an allowlisted email. */
export async function createLoginToken(email: string): Promise<string | null> {
  const user = userForEmail(email);
  if (!user) return null;
  const token = randomBytes(24).toString("base64url");
  await redis.set(`login:${token}`, user.email, { ex: LOGIN_TTL_S });
  return token;
}

/** Redeem a login token (single use). */
export async function consumeLoginToken(token: string): Promise<User | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const email = await redis.getdel<string>(`login:${token}`);
  return email ? userForEmail(email) : null;
}

// ── 6-digit login code (primary path for the installed PWA) ─────────────────
// A link opened from Mail lands in Safari's cookie jar, not the home-screen
// app's; a code typed inside the app sets the cookie where it's needed. Codes
// also can't be pre-consumed by email link scanners.
//
// Guessing is bounded across codes, not per code: a new code doesn't reset the count, so
// requesting codes in a loop can't turn 5 guesses into unlimited ones. And codes can only be
// requested so often (no mailbox flooding, no burning the send quota).
const MAX_CODE_TRIES = 5; // per code
const MAX_FAILS_HOUR = 10; // per email, across codes
const MAX_FAILS_DAY = 20;
const MAX_REQUESTS_HOUR = 5;
const REQUEST_GAP_S = 30;

/** Why a code can't be sent right now, or null. */
export async function loginRequestBlocked(email: string): Promise<string | null> {
  const user = userForEmail(email);
  if (!user) return null;
  const k = user.email;
  if (!(await redis.set(`loginreq_gap:${k}`, 1, { ex: REQUEST_GAP_S, nx: true }))) return "Wait a few seconds before asking for another code.";
  const n = await redis.incr(`loginreq_hour:${k}`);
  if (n === 1) await redis.expire(`loginreq_hour:${k}`, 3600);
  if (n > MAX_REQUESTS_HOUR) return "Too many codes requested. Try again in an hour.";
  if (await loginLocked(k)) return "Too many wrong codes. Try again later.";
  return null;
}

async function loginLocked(email: string): Promise<boolean> {
  const [h, d] = await Promise.all([redis.get<number>(`loginfail_hour:${email}`), redis.get<number>(`loginfail_day:${email}`)]);
  return Number(h || 0) >= MAX_FAILS_HOUR || Number(d || 0) >= MAX_FAILS_DAY;
}

async function countFail(email: string): Promise<void> {
  for (const [k, ttl] of [[`loginfail_hour:${email}`, 3600], [`loginfail_day:${email}`, 86400]] as const) {
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, ttl);
  }
}

export async function createLoginCode(email: string): Promise<string | null> {
  const user = userForEmail(email);
  if (!user) return null;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await redis.set(`logincode:${user.email}`, code, { ex: LOGIN_TTL_S });
  await redis.set(`logintries:${user.email}`, 0, { ex: LOGIN_TTL_S });
  return code;
}

export async function consumeLoginCode(email: string, code: string): Promise<User | null> {
  const user = userForEmail(email);
  if (!user || !/^\d{6}$/.test(code)) return null;
  if (await loginLocked(user.email)) return null;
  const tries = await redis.incr(`logintries:${user.email}`);
  if (tries > MAX_CODE_TRIES) {
    // Guesses past a code's limit still count toward the lockout.
    await redis.del(`logincode:${user.email}`).catch(() => {});
    await countFail(user.email);
    return null;
  }
  const stored = await redis.get<string | number>(`logincode:${user.email}`);
  if (stored == null || String(stored).padStart(6, "0") !== code) {
    await countFail(user.email);
    return null;
  }
  await redis.del(`logincode:${user.email}`, `logintries:${user.email}`).catch(() => {});
  return user;
}

// Sessions are stored under a hash of the cookie value: a read of the database alone
// doesn't yield a working cookie.
const sessionKey = (id: string) => `session:h:${createHash("sha256").update(id).digest("base64url")}`;

export async function createSession(user: User): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await redis.set(sessionKey(id), { email: user.email, createdAt: new Date().toISOString() }, { ex: SESSION_TTL_S });
  return id;
}

/** End a session by its cookie value (logout; test scripts). */
export async function endSession(id: string): Promise<void> {
  await redis.del(sessionKey(id), `session:${id}`).catch(() => {});
}

/** The session id in this request's cookie (well-formed), or null. */
export function sessionIdOf(req: VercelRequest): string | null {
  const id = readCookie(req, COOKIE);
  return id && /^[A-Za-z0-9_-]{20,64}$/.test(id) ? id : null;
}

function readCookie(req: VercelRequest, name: string): string | null {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The logged-in parent for this request, or null. */
export async function requireUser(req: VercelRequest): Promise<User | null> {
  const id = sessionIdOf(req);
  if (!id) return null;
  // Read + slide the expiry in one command (GETEX): an active phone stays logged in.
  let s = await redis.getex<{ email: string; createdAt?: string }>(sessionKey(id), { ex: SESSION_TTL_S });
  if (!s) {
    // A session from before hashing: move it under its hashed key.
    s = await redis.getdel<{ email: string; createdAt?: string }>(`session:${id}`);
    if (s) await redis.set(sessionKey(id), s, { ex: SESSION_TTL_S });
  }
  if (!s?.email) return null;
  // Sliding, but not forever: a device signs in again after a year.
  if (s.createdAt && Date.now() - Date.parse(s.createdAt) > 365 * 86400_000) {
    await endSession(id);
    return null;
  }
  return userForEmail(s.email);
}

/** The signed-in user, only if a parent (logins/cards, inbox and calendar connections, setup). */
export async function requireParent(req: VercelRequest): Promise<User | null> {
  const u = await requireUser(req);
  return u && u.role === "parent" ? u : null;
}

export function setSessionCookie(res: VercelResponse, id: string): void {
  res.setHeader(
    "set-cookie",
    `${COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}`
  );
}

export async function clearSession(req: VercelRequest, res: VercelResponse): Promise<void> {
  const id = sessionIdOf(req);
  if (id) await endSession(id);
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

/**
 * The public origin this request arrived on (the app is served on two hostnames). Only those
 * hostnames: login links and file links are built from it, and a forged Host header must
 * never put another site into an email Kimi sends.
 */
const APP_HOSTS = new Set(
  [process.env.APP_URL, "https://your-app.vercel.app", "https://your-app.vercel.app"]
    .filter(Boolean)
    .map((u) => { try { return new URL(u!).host; } catch { return ""; } })
);
export function requestOrigin(req: VercelRequest): string {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  if (APP_HOSTS.has(host)) return `https://${host}`;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && !process.env.VERCEL) return `http://${host}`;
  return process.env.APP_URL || "https://your-app.vercel.app";
}
