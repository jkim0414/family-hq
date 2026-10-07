import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../_lib/http.js";
import { requireParent } from "../_lib/auth.js";
import { addAudit } from "../_lib/db.js";
import { vaultConfigured, listCredentials, addCredential, removeCredential } from "../_lib/vault.js";
import { opConfigured, opVaultName, invalidateOpCache } from "../_lib/onepassword.js";

// GET  /api/vault                                   → { configured, onePassword: {connected, vault}, credentials: [{name, site, username, source}] }
// POST /api/vault { name, site, username, password } → add/replace a local entry
// POST /api/vault { remove: name }                  → remove a local entry
// POST /api/vault { refresh: true }                 → re-read the 1Password vault
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await requireParent(req);
  if (!user) return json(res, 401, { error: "unauthorized" });
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (body?.refresh) {
        await invalidateOpCache();
        return json(res, 200, { ok: true });
      }
      if (!vaultConfigured()) return json(res, 503, { error: "The local vault isn't set up (VAULT_KEY missing)." });
      if (body?.remove) {
        await removeCredential(String(body.remove));
        await addAudit({ kind: "vault", summary: `Removed credential "${body.remove}"`, by: user.id });
        return json(res, 200, { ok: true });
      }
      const e = await addCredential({ name: String(body?.name || ""), site: String(body?.site || ""), username: String(body?.username || ""), password: String(body?.password || "") });
      await addAudit({ kind: "vault", summary: `Saved credential "${e.name}" (${e.site})`, by: user.id });
      return json(res, 200, { ok: true, credential: { name: e.name, site: e.site, username: e.username } });
    }
    res.setHeader("cache-control", "no-store");
    json(res, 200, {
      configured: vaultConfigured(),
      onePassword: { connected: opConfigured(), vault: opVaultName() },
      credentials: await listCredentials(),
    });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}
