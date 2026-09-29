import { useState } from "react";
import { useData } from "../dataStore";
import { KimiAvatar } from "./ui";

// Login for a two-parent household app. Step 1: email → we send a 6-digit code
// (plus a link for plain browsers). Step 2: type the code HERE — that sets the
// session cookie in this app's own cookie jar, which matters for the
// home-screen PWA (a link tapped from Mail logs in Safari, not the app).
export function Login() {
  const { requestLogin, refresh } = useData();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidLink = new URLSearchParams(window.location.search).get("login") === "invalid";

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestLogin(email.trim());
      setStep("code");
    } catch {
      setError("Couldn't send the code — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || "That code didn't work.");
        return;
      }
      window.history.replaceState(null, "", "/");
      await refresh(); // cookie is set → /api/data now 200 → app renders
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 py-16">
      <div className="w-full rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <KimiAvatar size={64} className="mb-3" />
        <div className="text-2xl font-bold text-ink">Family HQ</div>
        <div className="text-sm text-ink-3">with Kimi, your family's assistant</div>

        {step === "email" ? (
          <>
            <p className="mt-1 text-sm text-ink-3">Log in once on this device. We'll email you a 6-digit code.</p>
            {invalidLink && (
              <div className="mt-4 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                That link expired or was already used — enter your email to get a fresh code.
              </div>
            )}
            <form onSubmit={sendCode} className="mt-5 space-y-3">
              <input
                type="email"
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-xl border border-line bg-fill px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                {busy ? "Sending…" : "Email me a code"}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-3">
              We sent a 6-digit code to <b>{email}</b>. Enter it here.
            </p>
            <form onSubmit={submitCode} className="mt-5 space-y-3">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                className="w-full rounded-xl border border-line bg-fill px-3 py-3 text-center text-2xl font-semibold tracking-[0.4em] focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                {busy ? "Logging in…" : "Log in"}
              </button>
            </form>
            <button
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
              className="mt-3 text-xs font-medium text-accent"
            >
              Resend or use a different email
            </button>
          </>
        )}

        {error && <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
      </div>
    </div>
  );
}
