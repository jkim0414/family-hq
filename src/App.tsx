import { useEffect, useState } from "react";
import { Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { useData } from "./dataStore";
import Home from "./views/Home";
import Chat, { unreadByThread } from "./views/Chat";
import { threadsFor } from "./data/threads";
import type { Member } from "./data/types";
import Agenda from "./views/Agenda";
import Household from "./views/Household";
import Assistant from "./views/Assistant";
import KidPage from "./views/KidPage";
import { Login } from "./components/Login";
import { needsYouCount } from "./components/NeedsYou";
import { Icon, KimiAvatar } from "./components/ui";

// Five destinations: the briefing, the conversation, the schedule, the
// household reference, and Kimi herself. Bottom tabs on phones, a
// sidebar on wide screens. Old URLs redirect so bookmarks and emailed links keep working.
const NAV = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/chat", label: "Chat", icon: "chat" },
  { to: "/agenda", label: "Agenda", icon: "calendar" },
  { to: "/household", label: "Household", icon: "people" },
  { to: "/assistant", label: "Kimi", icon: "kimi" },
] as const;

/** Unread replies from Kimi since this device last opened Chat. */
function useChatUnread(active: boolean, me: Member | undefined): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      if (document.visibilityState !== "visible" || !me) return;
      try {
        // New replies across every chat this member is in.
        const counts = await unreadByThread(threadsFor(me));
        if (!stop) setN(Object.values(counts).reduce((a, b) => a + b, 0));
      } catch {
        /* offline */
      }
    };
    check();
    const iv = setInterval(check, 60000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [active, me]);
  return active ? 0 : n;
}

/**
 * While the on-screen keyboard is up (a text field is focused on a touch device):
 * iOS doesn't shrink the page — it scrolls the whole app up under the status bar and
 * keeps the tab bar + home-indicator padding above the keyboard. Instead, size the app to
 * the visible area, pin it to the top, and hide the tab bar.
 */
function useKeyboard(): { open: boolean; height: number | null } {
  const [state, setState] = useState<{ open: boolean; height: number | null }>({ open: false, height: null });
  useEffect(() => {
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;
    const vv = window.visualViewport;
    const typing = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|file|range|color)$/i.test((el as HTMLInputElement).type)) || el.isContentEditable);
    };
    const update = () => {
      const open = typing();
      const h = vv && open && window.innerHeight - vv.height > 80 ? Math.round(vv.height) : null;
      setState((s) => (s.open === open && s.height === h ? s : { open, height: h }));
      if (open && vv && window.scrollY !== 0) window.scrollTo(0, 0);
    };
    // Focus changes settle before the keyboard animates; viewport events track the animation.
    const later = () => setTimeout(update, 0);
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, []);
  return state;
}

export default function App() {
  const loc = useLocation();
  const kb = useKeyboard();
  const { data, refresh, loading, authed, logout } = useData();
  const onChat = loc.pathname.startsWith("/chat");
  const unread = useChatUnread(onChat, data.me?.id as Member | undefined);
  if (authed === "no") return <Login />;

  const needs = needsYouCount(data.actions, data.suggestions, data.todos, data.me);
  const isActive = (to: string) => (to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(to));
  const badge = (to: string) => (to === "/" ? needs : to === "/chat" ? unread : 0);

  return (
    <div style={kb.height ? { height: kb.height } : undefined} className="mx-auto flex h-[100dvh] max-w-md flex-col overflow-hidden md:h-auto md:min-h-full md:max-w-5xl md:flex-row md:gap-10 md:overflow-visible md:px-6">
      {/* Wide screens: persistent sidebar */}
      <aside className="hidden md:sticky md:top-0 md:flex md:h-screen md:w-56 md:shrink-0 md:flex-col md:py-8">
        <div className="mb-6 px-3 text-[17px] font-bold text-ink">Family HQ</div>
        <nav className="space-y-0.5" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={`flex min-h-[42px] items-center gap-3 rounded-xl px-3 text-[15px] font-medium ${isActive(n.to) ? "bg-surface text-accent shadow-card ring-1 ring-line/70" : "text-ink-2 hover:bg-surface/60"}`}>
              {n.icon === "kimi" ? <KimiAvatar size={22} className={isActive(n.to) ? "ring-2 ring-accent" : ""} /> : <Icon name={n.icon} className="h-5 w-5" />}
              <span className="flex-1">{n.label}</span>
              {badge(n.to) > 0 && <Badge n={badge(n.to)} />}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-1 px-3 text-[13px] text-ink-3">
          <button onClick={() => refresh()} className="block min-h-[32px] font-medium hover:text-ink-2">
            <span className={`inline-block ${loading ? "animate-spin" : ""}`}>↻</span> Refresh
          </button>
          <button onClick={() => logout()} className="block min-h-[32px] font-medium hover:text-ink-2">
            Log out
          </button>
        </div>
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Phones: the page's large title is the header; only the safe area sits above it. */}
        <div className="shrink-0 md:hidden" style={{ height: "env(safe-area-inset-top)" }} />
        {loading && <span className="pointer-events-none absolute right-4 top-2 z-10 animate-spin text-[13px] text-ink-3 md:hidden" aria-label="Refreshing" style={{ marginTop: "env(safe-area-inset-top)" }}>↻</span>}

        <main className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 ${onChat ? "pb-2" : "pb-6"} md:max-w-2xl md:overflow-visible md:px-0 md:pb-12 md:pt-8`}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/agenda" element={<Agenda />} />
            <Route path="/household" element={<Household />} />
            <Route path="/household/kids/:id" element={<KidPage />} />
            <Route path="/assistant" element={<Assistant />} />
            {/* Old destinations */}
            <Route path="/kids/:id" element={<KidPage />} />
            <Route path="/calendar" element={<Navigate to="/agenda" replace />} />
            <Route path="/todos" element={<Navigate to="/agenda" replace />} />
            <Route path="/kids" element={<Navigate to="/household" replace />} />
            <Route path="/directory" element={<Navigate to="/household" replace />} />
            <Route path="/inbox" element={<Navigate to="/assistant#history" replace />} />
            <Route path="/activity" element={<Navigate to="/assistant" replace />} />
            <Route path="/digest" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      {/* Phones: translucent bottom tab bar */}
      <nav className={`safe-bottom z-10 shrink-0 border-t border-line/80 bg-surface/85 px-1 pt-1.5 backdrop-blur-xl md:hidden ${kb.open ? "hidden" : ""}`} aria-label="Main">
        <div className="flex items-stretch justify-around">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={`relative flex min-h-[50px] flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-medium ${isActive(n.to) ? "text-accent" : "text-ink-3"}`}>
              {n.icon === "kimi" ? <KimiAvatar size={26} className={isActive(n.to) ? "ring-2 ring-accent" : "opacity-80"} /> : <Icon name={n.icon} className="h-[26px] w-[26px]" />}
              {n.label}
              {badge(n.to) > 0 && (
                <span className="absolute right-[calc(50%-24px)] top-0">
                  <Badge n={badge(n.to)} />
                </span>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

function Badge({ n }: { n: number }) {
  return <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-[18px] text-white">{n > 9 ? "9+" : n}</span>;
}
