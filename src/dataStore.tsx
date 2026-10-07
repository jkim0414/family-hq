import { normalizeProfile } from "./data/facts";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { KIDS } from "./data/kids";
import { CONTACTS, PLACES, ROUTINES } from "./data/meta";
import type { Comm, Contact, CalEvent, Kid, Place, Routine, Todo, Suggestion, HouseholdProfile, Action, AuditEntry, Purchase, Schedule } from "./data/types";

export interface AppState {
  kids: Kid[];
  places: Place[];
  contacts: Contact[];
  routines: Routine[];
  comms: Comm[];
  events: CalEvent[];
  todos: Todo[];
  suggestions: Suggestion[];
  actions: Action[];
  audit: AuditEntry[];
  spending: Purchase[];
  schedules: Schedule[];
  profile: HouseholdProfile;
  /** Who's signed in. A caregiver gets a trimmed app (her own chat; no money, logins, or setup). */
  me?: { id: string; name: string; role: "parent" | "caregiver" };
}

// Initial state before live data loads: the real roster/directory (stable, bundled)
// with EMPTY dynamic collections — so no demo comms/events/todos ever flash on load.
const INITIAL: AppState = {
  kids: KIDS,
  places: PLACES,
  contacts: CONTACTS,
  routines: ROUTINES,
  comms: [],
  events: [],
  todos: [],
  suggestions: [],
  actions: [],
  audit: [],
  spending: [],
  schedules: [],
  profile: { facts: [], people: [] },
};

// Cache the last live data so loads render instantly (and work offline) — no flash.
const CACHE_KEY = "fhq:data";
function readCache(): AppState | null {
  try {
    const j = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return j && Array.isArray(j.kids) ? { ...j, profile: normalizeProfile(j.profile) } : null;
  } catch {
    return null;
  }
}

type EditableCollection = "events" | "todos" | "kids" | "contacts" | "places" | "routines";
type UndoableCollection = "events" | "todos" | "schedules";
type PendingDelete = { collection: UndoableCollection; id: string; title: string; timer: number };
const UNDO_MS = 5000;

type Authed = "unknown" | "yes" | "no";

interface DataCtx {
  data: AppState;
  loading: boolean;
  source: "live" | "seed";
  authed: Authed;
  requestLogin: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  toggleTodo: (id: string, done: boolean) => void;
  mutate: (collection: EditableCollection, op: "upsert" | "delete", item: { id: string } & Record<string, unknown>) => Promise<void>;
  /** Delete with a 5-second Undo (swipe to delete): hidden at once, removed for real when the toast ends. */
  removeWithUndo: (collection: UndoableCollection, item: { id: string; title?: string }) => void;
  capture: (text: string, images?: { mediaType: string; data: string }[]) => Promise<any>;
  suggestion: (id: string, action: "apply" | "dismiss") => Promise<void>;
  decideAction: (id: string, decision: "approve" | "decline") => Promise<void>;
  saveProfile: (profile: HouseholdProfile) => Promise<void>;
  refresh: () => void;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const Ctx = createContext<DataCtx | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppState>(() => readCache() || INITIAL);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"live" | "seed">("seed");
  const [authed, setAuthed] = useState<Authed>("unknown");

  // The server bumps a version on every write; a reload that finds the same
  // version costs one tiny request. Concurrent callers share one fetch.
  const version = useRef<number>(0);
  const inflight = useRef<Promise<void> | null>(null);
  const lastLoad = useRef<number>(0);

  function load(force = false): Promise<void> {
    if (inflight.current) return inflight.current;
    const p = (async () => {
      try {
        const qs = !force && version.current ? `?v=${version.current}` : `?t=${Date.now()}`;
        const res = await fetch(`/api/data${qs}`, { cache: "no-store" });
        if (res.status === 401) {
          // Not logged in on this device: drop any cached data and show the login screen.
          setAuthed("no");
          try {
            localStorage.removeItem(CACHE_KEY);
          } catch {
            /* ignore */
          }
          setData(INITIAL);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as AppState & { v?: number; unchanged?: boolean };
        setAuthed("yes");
        if (json.unchanged) return;
        if (typeof json.v === "number") version.current = json.v;
        // Guard against an empty/unseeded store wiping the UI.
        if (json && Array.isArray(json.kids) && json.kids.length) {
          const merged = { ...INITIAL, ...json, profile: normalizeProfile(json.profile) };
          setData(merged);
          setSource("live");
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(merged));
          } catch {
            /* cache best-effort */
          }
        }
      } catch {
        // offline / fetch failed → keep whatever we have (cache or roster), no demo data
      } finally {
        lastLoad.current = Date.now();
        setLoading(false);
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  }

  /** After a write: don't piggyback on a fetch that started before it. */
  async function reloadAfterWrite(): Promise<void> {
    if (inflight.current) await inflight.current;
    return load();
  }

  useEffect(() => {
    load(true);
    // Refresh when the app comes back to the foreground (focus and
    // visibilitychange both fire — take one), and every minute while visible so
    // things Kimi files in the background show up without a manual refresh.
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - lastLoad.current > 3000) load();
    };
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  function toggleTodo(id: string, done: boolean) {
    setData((d) => ({
      ...d,
      todos: d.todos.map((t) => (t.id === id ? { ...t, done } : t)),
    }));
    fetch("/api/todo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, done }),
    }).catch(() => {/* optimistic; will reconcile on next load */});
  }

  async function mutate(
    collection: EditableCollection,
    op: "upsert" | "delete",
    item: { id: string } & Record<string, unknown>
  ) {
    // Optimistic local update.
    setData((d) => {
      const list = [...(d[collection] as { id: string }[])];
      if (op === "delete") {
        return { ...d, [collection]: list.filter((x) => x.id !== item.id) };
      }
      const idx = list.findIndex((x) => x.id === item.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...item };
      else list.push(item);
      return { ...d, [collection]: list };
    });
    try {
      await fetch("/api/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, collection, item, id: item.id }),
      });
    } finally {
      reloadAfterWrite(); // reconcile with server (generated ids, gcal sync, etc.)
    }
  }

  // ── Swipe to delete, with Undo ────────────────────────────────────────────
  // The item disappears at once; the real delete (which for an event also removes it from Google
  // Calendar) waits until the Undo toast is gone. Leaving the app sends any waiting deletes.
  const [pending, setPending] = useState<PendingDelete[]>([]);
  const pendingRef = useRef<PendingDelete[]>([]);
  pendingRef.current = pending;

  function commitDelete(p: PendingDelete, keepalive = false) {
    window.clearTimeout(p.timer);
    const req =
      p.collection === "schedules"
        ? fetch("/api/schedules", { method: "POST", keepalive, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: p.id, cancel: true }) })
        : fetch("/api/mutate", { method: "POST", keepalive, headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "delete", collection: p.collection, id: p.id, item: { id: p.id } }) });
    return req
      .catch(() => {})
      .then(() => (keepalive ? undefined : reloadAfterWrite()))
      .finally(() => setPending((xs) => xs.filter((x) => x.id !== p.id)));
  }

  function removeWithUndo(collection: UndoableCollection, item: { id: string; title?: string }) {
    const p: PendingDelete = { collection, id: item.id, title: item.title || "item", timer: 0 };
    p.timer = window.setTimeout(() => commitDelete(p), UNDO_MS);
    setPending((xs) => [...xs.filter((x) => x.id !== item.id), p]);
  }

  function undoDelete(id: string) {
    const p = pendingRef.current.find((x) => x.id === id);
    if (p) window.clearTimeout(p.timer);
    setPending((xs) => xs.filter((x) => x.id !== id));
  }

  useEffect(() => {
    const flush = () => pendingRef.current.forEach((p) => commitDelete(p, true));
    const onHide = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  // What the app sees: everything except items waiting out their Undo.
  const visible = useMemo(() => {
    if (!pending.length) return data;
    const gone = new Set(pending.map((p) => p.id));
    return { ...data, todos: data.todos.filter((x) => !gone.has(x.id)), events: data.events.filter((x) => !gone.has(x.id)), schedules: data.schedules.filter((x) => !gone.has(x.id)) };
  }, [data, pending]);
  const last = pending[pending.length - 1];

  async function capture(text: string, images?: { mediaType: string; data: string }[]) {
    let result: any = {};
    try {
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, images: images || [] }),
      });
      result = await res.json().catch(() => ({}));
    } finally {
      await reloadAfterWrite();
    }
    return result;
  }

  async function suggestion(id: string, action: "apply" | "dismiss") {
    // Optimistically remove from the list.
    setData((d) => ({ ...d, suggestions: d.suggestions.filter((s) => s.id !== id) }));
    try {
      await fetch("/api/suggestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
    } finally {
      await reloadAfterWrite();
    }
  }

  async function decideAction(id: string, decision: "approve" | "decline") {
    // Optimistically drop it from the pending list; the server result reconciles on reload.
    setData((d) => ({
      ...d,
      actions: (d.actions || []).map((a) => (a.id === id ? { ...a, status: decision === "approve" ? "executed" : "declined" } : a)),
    }));
    try {
      await fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
    } finally {
      await reloadAfterWrite();
    }
  }

  async function saveProfile(profile: HouseholdProfile) {
    setData((d) => ({ ...d, profile }));
    try {
      await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile }),
      });
    } finally {
      await reloadAfterWrite();
    }
  }

  async function requestLogin(email: string) {
    await fetch("/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  async function logout() {
    await fetch("/api/auth/session", { method: "POST" }).catch(() => {});
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* ignore */
    }
    setData(INITIAL);
    setAuthed("no");
  }

  return (
    <Ctx.Provider
      value={{ data: visible, loading, source, authed, requestLogin, logout, toggleTodo, mutate, removeWithUndo, capture, suggestion, decideAction, saveProfile, refresh: () => load(true) }}
    >
      {children}
      {last && (
        <div role="status" className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 flex justify-center px-4 md:bottom-8">
          <div className="flex max-w-md items-center gap-3 rounded-full bg-ink px-4 py-2.5 text-sm text-surface shadow-lg">
            <span className="min-w-0 truncate">
              {last.collection === "schedules" ? "Cancelled" : "Deleted"} “{last.title}”
            </span>
            <button type="button" onClick={() => undoDelete(last.id)} className="shrink-0 font-bold text-surface underline underline-offset-2">
              Undo
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useData() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useData must be used within DataProvider");
  return ctx;
}
