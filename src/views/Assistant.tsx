import { useEffect, useState } from "react";
import { useData } from "../dataStore";
import { Card, SectionHeader, Button, Toggle, KimiAvatar } from "../components/ui";
import { SavedLogins } from "../components/SavedLogins";
import { FilesList } from "../components/FilesList";
import { SpendingList } from "../components/SpendingList";
import { ScheduledList } from "../components/ScheduledList";
import { SetupList } from "../components/SetupList";
import { History } from "../components/History";
import { pushState, enablePush, disablePush, type PushState } from "../push";

const JUMPS = [
  ["connections", "Connections"],
  ["setup", "Setup"],
  ["logins", "Logins"],
  ["scheduled", "Scheduled"],
  ["files", "Files"],
  ["spending", "Spending"],
  ["history", "History"],
] as const;

// Everything about Kimi herself: what she can reach, what she may sign into, what
// it produced, and what it did.
export default function Assistant() {
  const { logout, data } = useData();
  // A caregiver's Kimi tab: notifications, her own reminders and files — no connections,
  // setup, logins, spending, or the household's activity log.
  const caregiver = data.me?.role === "caregiver";
  const jumps = caregiver ? JUMPS.filter(([id]) => id === "scheduled" || id === "files") : JUMPS;

  return (
    <div className="space-y-8">
      <KimiHeader />

      <div className="no-scrollbar -mx-4 -mt-3 flex gap-2 overflow-x-auto px-4 py-1 md:mx-0 md:px-0.5">
        {jumps.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="min-h-[36px] shrink-0 rounded-full bg-surface px-3 text-xs font-medium leading-[36px] text-ink-2 ring-1 ring-line">
            {label}
          </a>
        ))}
      </div>

      {caregiver ? (
        <section id="connections">
          <SectionHeader title="Notifications" hint="How Kimi reaches you on this phone." />
          <Card>
            <Notifications />
          </Card>
        </section>
      ) : (
        <section id="connections">
          <SectionHeader title="Connections" hint="What Kimi reads and how she reaches you." />
          <Card className="divide-y divide-line">
            <GmailConnection />
            <WorkCalendar who="alex" />
            <WorkCalendar who="sam" />
            <Notifications />
          </Card>
        </section>
      )}

      {!caregiver && <SetupList />}
      {!caregiver && <SavedLogins />}
      <ScheduledList />
      <FilesList />
      {!caregiver && <SpendingList />}
      {!caregiver && <History />}

      <section>
        <Card>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-[15px] text-ink">This device</div>
              <div className="text-xs text-ink-3">Version {__BUILD__}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => logout()}>
              Log out
            </Button>
          </div>
        </Card>
      </section>
    </div>
  );
}

function KimiHeader() {
  return (
    <div className="mb-4 flex items-center gap-4 px-1">
      <KimiAvatar size={72} className="shadow-card" />
      <div className="min-w-0">
        <h1 className="text-[32px] font-bold leading-tight text-ink">Kimi</h1>
        <p className="text-[15px] text-ink-3">Your family's assistant — what she can reach, what she's made, and what she's done.</p>
      </div>
    </div>
  );
}

// Each parent's own Gmail: connected via app password, optionally watched.
function GmailConnection() {
  const [st, setSt] = useState<{ me: { connected: boolean; email: string; via?: string; watch?: boolean }; other: { id: string; connected: boolean; email: string; via?: string; watch?: boolean } } | null>(null);
  const [busy, setBusy] = useState(false);
  const result = new URLSearchParams(window.location.search).get("gmail");

  const load = async () => {
    try {
      const r = await fetch(`/api/gmail?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) setSt(await r.json());
    } catch {
      /* offline */
    }
  };
  useEffect(() => {
    load();
  }, []);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch("/api/gmail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const otherName = st?.other.id === "sam" ? "Sam" : "Alex";
  const note =
    result === "connected"
      ? { text: "Gmail connected.", cls: "text-ok" }
      : result === "denied"
      ? { text: "Google sign-in was cancelled.", cls: "text-ink-3" }
      : result === "noref"
      ? { text: "Google didn't return a long-lived token — remove Family HQ at myaccount.google.com/permissions and try again.", cls: "text-danger" }
      : result === "error"
      ? { text: "Connecting failed — try again.", cls: "text-danger" }
      : null;

  return (
    <>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] text-ink">My Gmail</div>
            <div className="truncate text-xs text-ink-3">
              {st === null ? "…" : st.me.connected ? st.me.email : "Not connected — ask Alex to add your app password."}
            </div>
            {st && (
              <div className="text-xs text-ink-3">
                {otherName}: {st.other.connected ? `connected${st.other.watch ? " · watching" : ""}` : "not connected"}
              </div>
            )}
            {note && <div className={`mt-0.5 text-xs ${note.cls}`}>{note.text}</div>}
          </div>
          {st?.me.connected && st.me.via === "google" ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => confirm("Disconnect your Gmail? Kimi will no longer be able to search it.") && post({ disconnect: true })}>
              Disconnect
            </Button>
          ) : st?.me.connected ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-ok">
              <span className="h-2 w-2 rounded-full bg-ok" />
              Connected
            </span>
          ) : null}
        </div>
      </div>
      {st?.me.connected && (
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[15px] text-ink">Watch my inbox</div>
            <div className="text-xs text-ink-3">
              {st.me.watch
                ? "Kimi reads new mail every 15 minutes and files what's about the kids or the household. No forwarding needed."
                : "Let Kimi read new mail as it arrives and file the school, activity, and household items herself."}
            </div>
          </div>
          <Toggle on={!!st.me.watch} disabled={busy} onChange={(v) => post({ watch: v })} label="Watch my inbox" />
        </div>
      )}
    </>
  );
}

// A parent's work calendar: read-only planning context, never shown on the Agenda.
function WorkCalendar({ who }: { who: "alex" | "sam" }) {
  const name = who === "alex" ? "Alex" : "Sam";
  const [st, setSt] = useState<{ connected: boolean; label?: string; next7days?: number; busyOnly?: boolean; error?: string } | null>(null);
  // The family calendar's Google account (from the server: no addresses are built into the app).
  const [shareWith, setShareWith] = useState("");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch(`/api/workcal?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        setSt(j[who]);
        setShareWith(j.shareWith || "");
      }
    } catch {
      /* offline */
    }
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/workcal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who, ...body }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.error || "Couldn't connect.");
      else {
        setEditing(false);
        setValue("");
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] text-ink">{name}'s work calendar</div>
          <div className="truncate text-xs text-ink-3">
            {st === null
              ? "…"
              : st.error
              ? st.error
              : st.connected
              ? `${st.label} · ${st.next7days ?? 0} events this week${st.busyOnly ? " (busy times only)" : ""} · for planning, not on the Agenda`
              : "Not connected — for planning only, never shown on the Agenda."}
          </div>
        </div>
        {st === null ? null : st.connected && !st.error ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`Disconnect ${name}'s work calendar?`) && save({ remove: true })}>
            Remove
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setEditing((e) => !e)}>
            {editing ? "Cancel" : "Connect"}
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-3 space-y-2 rounded-xl bg-fill p-3 text-[13px] text-ink-2">
          <p>
            <b>Google (Workspace):</b> in Google Calendar → Settings → your work calendar → <i>Share with specific people</i>, add <b>{shareWith || "the family calendar's Google account"}</b> with <i>See all event details</i>. Then enter the work email below.
          </p>
          <p>
            <b>Outlook / Microsoft 365:</b> Settings → Calendar → Shared calendars → <i>Publish a calendar</i> → <i>Can view all details</i> → copy the ICS link and paste it below.
          </p>
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="work email or https://…ics"
              autoCapitalize="off"
              autoCorrect="off"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
            <Button size="sm" disabled={busy || !value.trim()} onClick={() => save({ value })}>
              {busy ? "Checking…" : "Save"}
            </Button>
          </div>
          {err && <p className="text-danger">{err}</p>}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    pushState().then(setState);
  }, []);

  const toggle = async () => {
    setErr(null);
    setState("loading");
    try {
      setState(state === "on" ? await disablePush() : await enablePush());
    } catch (e) {
      setErr(String((e as Error).message || e));
      setState(await pushState());
    }
  };

  const standalone = typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone);
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] text-ink">Notifications</div>
          <div className="text-xs text-ink-3">
            {state === "unsupported"
              ? standalone
                ? "Not supported on this device."
                : "Add the app to your home screen first, then enable here."
              : state === "denied"
              ? "Blocked in system settings for this app."
              : "Kimi's messages and approval requests, as they happen."}
          </div>
          {err && <div className="text-xs text-danger">{err}</div>}
        </div>
        <Toggle on={state === "on"} disabled={state === "loading" || state === "unsupported" || state === "denied"} onChange={toggle} label="Notifications on this device" />
      </div>
    </div>
  );
}
