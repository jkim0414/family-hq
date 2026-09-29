import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { redis } from "./db.js";
import { opConfigured, listOpLogins, getOpField } from "./onepassword.js";

// ─────────────────────────────────────────────────────────────────────────────
// Credential vault for the browser agent. Passwords are AES-256-GCM encrypted
// with VAULT_KEY (64 hex chars, only in Vercel env). The agent can ask for a
// credential to be FILLED into a page field; it never sees the secret.
// ─────────────────────────────────────────────────────────────────────────────

export interface VaultEntry {
  name: string; // short handle, e.g. "opentable", "activenet"
  site: string; // login URL or domain
  username: string;
  enc: { iv: string; ct: string; tag: string };
  createdAt: string;
}

export function vaultConfigured(): boolean {
  return /^[0-9a-f]{64}$/i.test(process.env.VAULT_KEY || "");
}

function key(): Buffer {
  if (!vaultConfigured()) throw new Error("VAULT_KEY (64 hex chars) is not set");
  return Buffer.from(process.env.VAULT_KEY!, "hex");
}

function encrypt(text: string): VaultEntry["enc"] {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

function decrypt(enc: VaultEntry["enc"]): string {
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(enc.iv, "base64"));
  d.setAuthTag(Buffer.from(enc.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc.ct, "base64")), d.final()]).toString("utf8");
}

const norm = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40);

export async function addCredential(input: { name: string; site: string; username: string; password: string }): Promise<VaultEntry> {
  const name = norm(input.name);
  if (!name || !input.password) throw new Error("name and password required");
  const entry: VaultEntry = { name, site: input.site.trim(), username: input.username.trim(), enc: encrypt(input.password), createdAt: new Date().toISOString() };
  await redis.set(`vault:${name}`, entry);
  await redis.sadd("vault_index", name);
  return entry;
}

export async function removeCredential(name: string): Promise<void> {
  const n = norm(name);
  await redis.del(`vault:${n}`);
  await redis.srem("vault_index", n);
}

export interface CredentialSummary {
  name: string;
  site: string;
  username: string;
  source: "vault" | "1password";
  hasOtp?: boolean;
}

/** True when the agent has SOME source of logins (local vault and/or 1Password). */
export function credentialsAvailable(): boolean {
  return vaultConfigured() || opConfigured();
}

/** Names/sites/usernames only — safe to show to the agent and the UI. Local vault entries plus the 1Password HQ vault. */
export async function listCredentials(): Promise<CredentialSummary[]> {
  const out: CredentialSummary[] = [];
  if (vaultConfigured()) {
    const names = (await redis.smembers("vault_index")) ?? [];
    const entries = await Promise.all(names.map((n) => redis.get<VaultEntry>(`vault:${n}`)));
    for (const e of entries) if (e) out.push({ name: e.name, site: e.site, username: e.username, source: "vault" });
  }
  if (opConfigured()) {
    try {
      for (const l of await listOpLogins()) out.push({ name: l.title, site: l.site, username: l.username, source: "1password", hasOtp: l.hasOtp });
    } catch (e) {
      console.error("1Password list failed", e);
      out.push({ name: `(1Password unavailable: ${String((e as Error).message || e).slice(0, 80)})`, site: "", username: "", source: "1password" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Server-side only: the plaintext for a given field. Never returned to the model. Local vault first, then 1Password. */
export async function getCredentialField(name: string, field: "username" | "password" | "otp"): Promise<string | null> {
  if (vaultConfigured()) {
    const e = await redis.get<VaultEntry>(`vault:${norm(name)}`);
    if (e) return field === "username" ? e.username : field === "password" ? decrypt(e.enc) : null;
  }
  if (opConfigured()) return getOpField(name, field);
  return null;
}
