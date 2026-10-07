import { randomBytes, randomInt } from "node:crypto";
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
const MAX_CODE_TRIES = 5;

export async function createLoginCode(email: string): Promise<string | null> {
  const user = userForEmail(email);
  if (!user) return null;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await redis.set(`logincode:${user.email}`, code, { ex: LOGIN_TTL_S });
  await redis.del(`logintries:${user.email}`).catch(() => {});
  return code;
}

export async function consumeLoginCode(email: string, code: string): Promise<User | null> {
  const user = userForEmail(email);
  if (!user || !/^\d{6}$/.test(code)) return null;
  const tries = await redis.incr(`logintries:${user.email}`);
  await redis.expire(`logintries:${user.email}`, LOGIN_TTL_S).catch(() => {});
  if (tries > MAX_CODE_TRIES) {
    await redis.del(`logincode:${user.email}`).catch(() => {});
    return null;
  }
  const stored = await redis.get<string | number>(`logincode:${user.email}`);
  if (stored == null || String(stored).padStart(6, "0") !== code) return null;
  await redis.del(`logincode:${user.email}`, `logintries:${user.email}`).catch(() => {});
  return user;
}

export async function createSession(user: User): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await redis.set(`session:${id}`, { email: user.email, createdAt: new Date().toISOString() }, { ex: SESSION_TTL_S });
  return id;
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
  const id = readCookie(req, COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;
  // Read + slide the expiry in one command (GETEX): an active phone stays logged in.
  const s = await redis.getex<{ email: string }>(`session:${id}`, { ex: SESSION_TTL_S });
  if (!s?.email) return null;
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
  const id = readCookie(req, COOKIE);
  if (id) await redis.del(`session:${id}`).catch(() => {});
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

/** The public origin this request arrived on (the app is served on two hostnames). */
export function requestOrigin(req: VercelRequest): string {
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "your-app.vercel.app";
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  return `${proto}://${host}`;
}
