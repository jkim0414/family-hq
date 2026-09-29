import { useEffect, useState } from "react";
import { Card, Button, Collapsible, TextAction } from "./ui";

interface CredRow {
  name: string;
  site: string;
  username: string;
  source: "vault" | "1password";
  hasOtp?: boolean;
}
interface VaultInfo {
  configured: boolean;
  onePassword: { connected: boolean; vault: string };
  credentials: CredRow[];
}

// Logins the assistant may use in the browser. The main source is a dedicated
// 1Password vault (read on demand — nothing copied); the local vault is the
// fallback for one-offs. The assistant can fill a password but never read it.
export function SavedLogins() {
  const [info, setInfo] = useState<VaultInfo>({ configured: false, onePassword: { connected: false, vault: "Family HQ" }, credentials: [] });
  const [showAdd, setShowAdd] = useState(false);
  const [cred, setCred] = useState({ name: "", site: "", username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const r = await fetch(`/api/vault?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        const v = await r.json();
        setInfo({ configured: !!v.configured, onePassword: v.onePassword || { connected: false, vault: "Family HQ" }, credentials: v.credentials || [] });
        setLoaded(true);
      }
    } catch {
      /* offline */
    }
  };
  useEffect(() => {
    load();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/vault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh: true }) });
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/vault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cred) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error || "Couldn't save.");
        return;
      }
      setCred({ name: "", site: "", username: "", password: "" });
      setShowAdd(false);
      load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Remove the saved login "${name}"?`)) return;
    await fetch("/api/vault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ remove: name }) });
    load();
  };

  const input = "w-full rounded-xl border border-line bg-fill px-3 py-2 text-sm focus:border-accent focus:outline-none";
  const op = info.onePassword;
  const opError = info.credentials.find((c) => c.source === "1password" && c.name.startsWith("(1Password"));
  const fromOp = info.credentials.filter((c) => c.source === "1password" && c !== opError);
  const local = info.credentials.filter((c) => c.source === "vault");

  return (
    <>
    {opError && (
      <div className="-mb-4 rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn">
        1Password is temporarily unavailable{/rate limit/i.test(opError.name) ? " (daily request limit reached)" : ""}. Kimi will try again later.
      </div>
    )}
    <Collapsible
      id="logins"
      title="Logins Kimi can use"
      count={loaded ? fromOp.length + local.length : undefined}
      defaultOpen={false}
      hint={
          !loaded
            ? undefined
            : op.connected
            ? `Connected to your 1Password vault “${op.vault}”. Move a login into that vault in 1Password and Kimi can use it — passwords are read at sign-in time and never shown to her.`
            : "Not connected to 1Password yet. Once connected, any login you move into the “Family HQ” vault is available here automatically."
        }
      actions={
        <>
          {op.connected && (
            <TextAction onClick={refresh} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </TextAction>
          )}
          {info.configured && <TextAction onClick={() => setShowAdd((s) => !s)}>{showAdd ? "Cancel" : "+ Add one-off"}</TextAction>}
        </>
      }
    >

      {showAdd && (
        <form onSubmit={save} className="mb-2 space-y-2 rounded-2xl bg-surface p-3 shadow-sm ring-1 ring-line">
          <div className="text-xs text-ink-3">For a login that doesn't live in 1Password. Stored encrypted on the server.</div>
          <input className={input} placeholder="Short name (e.g. activenet)" value={cred.name} onChange={(e) => setCred({ ...cred, name: e.target.value })} required />
          <input className={input} placeholder="Site (e.g. apm.activecommunities.com/yourcity)" value={cred.site} onChange={(e) => setCred({ ...cred, site: e.target.value })} />
          <input className={input} placeholder="Username / email" autoCapitalize="off" value={cred.username} onChange={(e) => setCred({ ...cred, username: e.target.value })} />
          <input className={input} type="password" placeholder="Password" value={cred.password} onChange={(e) => setCred({ ...cred, password: e.target.value })} required />
          {err && <div className="text-xs text-danger">{err}</div>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Saving…" : "Save login"}
          </Button>
        </form>
      )}

      {fromOp.length + local.length === 0 ? (
        !opError && (
        <div className="text-sm text-ink-3">{op.connected ? `The “${op.vault}” vault is empty so far.` : "No logins yet."}</div>
        )
      ) : (
        <Card className="divide-y divide-line">
          {[...fromOp, ...local].map((c) => (
            <div key={`${c.source}-${c.name}`} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <span aria-hidden>🔑</span>
                  <span className="truncate">{c.name}</span>
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${c.source === "1password" ? "bg-accent-soft text-accent" : "bg-fill text-ink-3"}`}>
                    {c.source === "1password" ? "1Password" : "local"}
                  </span>
                  {c.hasOtp && <span className="shrink-0 rounded bg-ok-soft px-1 py-0.5 text-[10px] font-semibold text-ok">2FA</span>}
                </div>
                <div className="truncate text-xs text-ink-3">
                  {c.site}
                  {c.username ? `${c.site ? " · " : ""}${c.username}` : ""}
                </div>
              </div>
              {c.source === "vault" && (
                <Button variant="danger" size="sm" onClick={() => remove(c.name)}>
                  Remove
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
    </Collapsible>
    </>
  );
}
