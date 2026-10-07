import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useData } from "../dataStore";
import { Button, Icon, KimiAvatar } from "../components/ui";
import { Markdown } from "../components/Markdown";
import { encodeFiles, isAttachable, MAX_ATTACHMENTS, type Att } from "../attachments";
import { fmtDateTime } from "../store";
import { personName } from "../data/people";
import { threadsFor, threadLabel, threadPeople, threadMembers, threadFor, MAIN_THREAD } from "../data/threads";
import type { Member } from "../data/types";
import type { TaskLogEntry, TaskStatus, Action, EmailPayload, StepPayload, Reaction } from "../data/types";

const REACTIONS = ["👍", "❤️", "😂", "‼️", "❓", "👎"];
const who = (by: Reaction["by"]) => (by === "kimi" ? "Kimi" : personName(by));

// The one place to tell Kimi anything. Text goes to her; a photo or
// PDF is filed straight away and she replies with what she did. Everything she
// does on the family's behalf shows up here inline: approvals to decide,
// background tasks with their status, files it wrote.

/** When this device last opened a chat (for unread badges). The family chat and Just me keep their original keys. */
export function seenKey(thread: string): string {
  if (thread === MAIN_THREAD) return "fhq:chatSeen";
  if (/^task-private-/.test(thread)) return "fhq:chatSeenPrivate";
  return `fhq:chatSeen:${thread}`;
}
/** Kimi's replies since this device last opened each chat. */
export async function unreadByThread(threads: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    threads.map(async (id) => {
      try {
        const seen = localStorage.getItem(seenKey(id)) || "1970-01-01";
        const q = /^task-private-/.test(id) ? "private" : id;
        const r = await fetch(`/api/tasks?id=${q}&after=${encodeURIComponent(seen)}`, { cache: "no-store" });
        out[id] = r.ok ? Number((await r.json()).unread) || 0 : 0;
      } catch {
        out[id] = 0;
      }
    })
  );
  return out;
}
type Thread = string;
const THREAD_KEY = "fhq:chatThread";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  kind?: string;
  updatedAt: string;
  lastReply?: string;
  privateTo?: string;
  parentThread?: string;
}
interface FileRow {
  id: string;
  title: string;
  createdAt: string;
  url: string;
  privateTo?: string;
  audience?: string[];
  thread?: string;
}

type Row =
  | { at: string; kind: "msg"; entry: TaskLogEntry }
  | { at: string; kind: "tools"; entries: TaskLogEntry[] }
  | { at: string; kind: "action"; a: Action }
  | { at: string; kind: "task"; t: TaskRow }
  | { at: string; kind: "file"; f: FileRow };

const STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: "Working", cls: "bg-accent-soft text-accent" },
  waiting: { label: "Needs you", cls: "bg-warn-soft text-warn" },
  done: { label: "Done", cls: "bg-fill text-ink-3" },
  failed: { label: "Failed", cls: "bg-danger-soft text-danger" },
  cancelled: { label: "Stopped", cls: "bg-fill text-ink-3" },
  proposed: { label: "Waiting for you", cls: "bg-warn-soft text-warn" },
  executed: { label: "Done", cls: "bg-ok-soft text-ok" },
  declined: { label: "Declined", cls: "bg-fill text-ink-3" },
};

const PAGE = 40;

const EXAMPLES = ["What's on this weekend?", "Move the dentist to Tuesday 3pm", "Remind me Thursday to send the permission slip", "Register Max for fall soccer"];

// The last thread this session showed, so reopening the tab paints it immediately
// (already at the bottom) instead of blank → oldest-first → jump.
type ChatCache = { log: TaskLogEntry[]; status: TaskStatus | null; tasks: TaskRow[]; files: FileRow[]; sig: string };
const cacheByThread: Record<Thread, ChatCache | null> = {};

// Each member's conversations with Kimi: their private "Just me" chat (also where their one-on-one
// texts land), the parents' family chat, and the shared chats with Grandma. The choice is remembered
// on this device.
export default function Chat() {
  const { data } = useData();
  const me = (data.me?.id || "alex") as Member;
  const mine = threadsFor(me);
  const [stored, setThread] = useState<string>(() => {
    try {
      const v = localStorage.getItem(THREAD_KEY) || "";
      return v === "private" ? threadFor([me]) : v === "family" ? MAIN_THREAD : v;
    } catch {
      return MAIN_THREAD;
    }
  });
  // A caregiver isn't in the parents' family chat; anyone lands in Just me if the saved chat isn't theirs.
  const thread = mine.includes(stored) ? stored : mine.includes(MAIN_THREAD) ? MAIN_THREAD : mine[0];
  const choose = (t: Thread) => {
    setThread(t);
    try {
      localStorage.setItem(THREAD_KEY, t);
    } catch {
      /* ignore */
    }
  };
  return <ChatThread key={thread} thread={thread} threads={mine} me={me} onThread={choose} />;
}

/** The chat an approval, task, or file came from. */
function homeThread(x: { thread?: string; parentThread?: string; privateTo?: string; audience?: string[] }): string {
  if (x.thread) return x.thread;
  if (x.parentThread) return x.parentThread;
  if (x.privateTo) return threadFor([x.privateTo as Member]);
  if (x.audience?.length) return threadFor(x.audience as Member[]);
  return MAIN_THREAD;
}

/** The chip for a chat: "🔒 Just me", the other person's name, or "Everyone". */
function chipLabel(t: string, me: Member): string {
  const ms = threadMembers(t) || [];
  if (ms.length >= 3) return "Everyone";
  return threadLabel(t, me);
}

function ChatThread({ thread, threads, me: myId, onThread }: { thread: Thread; threads: string[]; me: Member; onThread: (t: Thread) => void }) {
  const { data, decideAction } = useData();
  const cached = cacheByThread[thread];
  const isPrivate = (threadMembers(thread) || []).length === 1;
  const isMain = thread === MAIN_THREAD;
  const caregiverView = data.me?.role === "caregiver";
  // Cards shown in a chat belong to it. A caregiver's purchase requests also show in the parents'
  // family chat, where they decide them.
  const inThread = (x: { thread?: string; parentThread?: string; privateTo?: string; audience?: string[]; requester?: string }) =>
    homeThread(x) === thread || (isMain && !!x.requester && x.requester !== myId && !(threadMembers(homeThread(x)) || []).includes(myId));
  // Unread dots on the other chats.
  const [unread, setUnread] = useState<Record<string, number>>({});
  useEffect(() => {
    const others = threads.filter((t) => t !== thread);
    const check = () => document.visibilityState === "visible" && unreadByThread(others).then(setUnread);
    check();
    const iv = setInterval(check, 30000);
    return () => clearInterval(iv);
  }, [thread]);
  const [log, setLog] = useState<TaskLogEntry[]>(cached?.log ?? []);
  const [status, setStatus] = useState<TaskStatus | null>(cached?.status ?? null);
  const [tasks, setTasks] = useState<TaskRow[]>(cached?.tasks ?? []);
  const [files, setFiles] = useState<FileRow[]>(cached?.files ?? []);
  const [loaded, setLoaded] = useState(!!cached);
  const [shown, setShown] = useState(PAGE);
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<string>("");
  // Reactions: press and hold (or right-click) a message to open the bar.
  const [picker, setPicker] = useState<string | null>(null);
  const hold = useRef<number | null>(null);
  // Press-and-hold is for touch screens only; with a mouse, holding the button is how you
  // select text, so on desktop only a right-click opens the bar.
  const holdAt = useRef<{ x: number; y: number } | null>(null);
  const holdStart = (k: string, ev: React.PointerEvent) => {
    if (ev.pointerType === "mouse") return;
    if (hold.current) clearTimeout(hold.current);
    holdAt.current = { x: ev.clientX, y: ev.clientY };
    hold.current = window.setTimeout(() => setPicker(k), 420);
  };
  const holdMove = (ev: React.PointerEvent) => {
    // A finger that moves is scrolling, not holding.
    const a = holdAt.current;
    if (a && Math.hypot(ev.clientX - a.x, ev.clientY - a.y) > 8) holdEnd();
  };
  const holdEnd = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  const react = async (e: TaskLogEntry, emoji: string) => {
    setPicker(null);
    if (!me) return;
    // Show it right away (same emoji again removes it, like a tapback); the server confirms on the next poll.
    const toggle = (xs: Reaction[] = []) => {
      const mine = xs.find((r) => r.by === me);
      const rest = xs.filter((r) => r.by !== me);
      return mine?.emoji === emoji ? rest : [...rest, { by: me as Reaction["by"], emoji, at: new Date().toISOString() }];
    };
    setLog((l) => l.map((x) => (x.at === e.at && x.kind === e.kind ? { ...x, reactions: toggle(x.reactions) } : x)));
    try {
      const r = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread, react: { at: e.at, kind: e.kind, emoji } }) });
      if (r.ok && (await r.json()).state === "replying") setStatus("running");
    } catch {
      /* the next poll shows the real state */
    }
    load(true);
  };
  const [note, setNote] = useState<{ text: string; kind: "error" | "info" } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Poll the cheap task list; only when something changed, pull the thread and files.
  const sig = useRef(cached?.sig ?? "");
  const load = async (force = false) => {
    const get = async (url: string) => {
      try {
        const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
        return r.ok ? r.json() : null;
      } catch {
        return null;
      }
    };
    const t = await get("/api/tasks");
    if (!t) return;
    const list: (TaskRow & { updatedAt: string })[] = t.tasks || [];
    const next = list.map((x) => `${x.id}:${x.updatedAt}:${x.status}`).sort().join("|") + `|r${t.reactionsVer || 0}`;
    const browserTasks = list.filter((x) => x.kind === "browser" && inThread(x));
    setTasks(browserTasks);
    if (cacheByThread[thread]) cacheByThread[thread]!.tasks = browserTasks;
    if (!force && next === sig.current) return;
    const [m, f] = await Promise.all([get(`/api/tasks?id=${isPrivate ? "private" : thread}`), get("/api/files")]);
    if (!m) return;
    // A private thread doesn't exist until its first message: show it empty, not loading.
    const tlog: TaskLogEntry[] = m.task?.log || [];
    if (m.me) setMe(m.me);
    const tstatus: TaskStatus | null = m.task?.status ?? null;
    const tfiles: FileRow[] = f ? (f.files || []).filter(inThread) : cacheByThread[thread]?.files || [];
    sig.current = next;
    setLog(tlog);
    setStatus(tstatus);
    setFiles(tfiles);
    setLoaded(true);
    cacheByThread[thread] = { log: tlog, status: tstatus, tasks: browserTasks, files: tfiles, sig: next };
    try {
      localStorage.setItem(seenKey(thread), new Date().toISOString());
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    load(true);
    // SMS-side messages and task progress — only while the app is on screen.
    const iv = setInterval(() => document.visibilityState === "visible" && load(), 15000);
    return () => clearInterval(iv);
  }, []);

  // The composer grows with its text (line breaks are allowed), up to its max height.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Before paint, so the thread never flashes at the top.
  useLayoutEffect(() => {
    // Past the end clamps to the newest message in both scroll models of a reversed list.
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, busy, tasks.length, loaded]);

  const stopTask = async (id: string) => {
    if (!confirm("Stop this task? Its browser session will be closed.")) return;
    await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, stop: true }) });
    load();
  };

  const addFiles = async (files: File[]) => {
    const { atts: more, error } = await encodeFiles(files.filter(isAttachable));
    if (error) setNote({ text: error, kind: "error" });
    if (more.length) setAtts((prev) => [...prev, ...more].slice(0, MAX_ATTACHMENTS));
  };

  const send = async (message = text.trim()) => {
    if ((!message && !atts.length) || busy) return;
    const sending = atts;
    setBusy(true);
    setNote(null);
    setText("");
    setAtts([]);
    setLog((l) => [...l, { at: new Date().toISOString(), kind: "user", who: "You", text: `${message}${sending.length ? `\n📎 ${sending.length} attachment${sending.length > 1 ? "s" : ""}` : ""}` }]);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, thread, attachments: sending.map(({ mediaType, data }) => ({ mediaType, data })) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote({ text: j.error || "Something went wrong — try again.", kind: "error" });
      } else if (j.log) {
        setLog(j.log);
        setStatus(j.status);
        if (cacheByThread[thread]) cacheByThread[thread] = { ...cacheByThread[thread]!, log: j.log, status: j.status };
        if (j.pending) setNote({ text: "Still working on it — you'll get a notification when it's done.", kind: "info" });
        load(true);
      }
    } catch {
      setNote({ text: "Couldn't reach Kimi — check your connection.", kind: "error" });
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  // Merge the transcript with the things Kimi did, by time.
  const rows: Row[] = [];
  for (const e of log) {
    if (e.kind === "system") continue;
    if (e.kind === "tool") {
      const last = rows[rows.length - 1];
      if (last?.kind === "tools") last.entries.push(e);
      else rows.push({ at: e.at, kind: "tools", entries: [e] });
    } else rows.push({ at: e.at, kind: "msg", entry: e });
  }
  for (const a of (data.actions || []).filter(inThread)) rows.push({ at: a.createdAt, kind: "action", a });
  for (const t of tasks) rows.push({ at: t.updatedAt, kind: "task", t });
  for (const f of files) rows.push({ at: f.createdAt, kind: "file", f });
  rows.sort((x, y) => x.at.localeCompare(y.at));
  // A long thread is tens of thousands of pixels; draw the recent part and page back on request.
  const hidden = Math.max(0, rows.length - shown);
  const visible = hidden ? rows.slice(hidden) : rows;

  return (
    <div className="flex h-full flex-col md:h-[calc(100vh-5rem)]">
      <div className="mb-2 flex items-center justify-between">
<div className="flex min-w-0 items-center gap-2.5">
          <KimiAvatar size={36} />
          <div>
            <h1 className="text-[22px] font-bold leading-tight text-ink">Kimi</h1>
            <div className="truncate text-[12px] text-ink-3">{isPrivate ? "Only you can see this" : `${threadPeople(thread, myId)}`}</div>
          </div>
        </div>
        {status === "waiting" && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-semibold text-warn">Follow-up scheduled</span>}
        {status === "running" && !busy && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">Working…</span>}
      </div>
      {threads.length > 1 && (
        <div className="-mx-4 mb-2 flex gap-1.5 overflow-x-auto px-4 pb-0.5 text-[13px] font-semibold [scrollbar-width:none] md:mx-0 md:px-0" role="tablist" aria-label="Conversation">
          {threads.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={thread === t}
              onClick={() => thread !== t && onThread(t)}
              className={`min-h-[34px] shrink-0 whitespace-nowrap rounded-full px-3.5 ${thread === t ? "bg-ink text-surface" : "bg-fill text-ink-2"}`}
            >
              {chipLabel(t, myId)}
              {thread !== t && (unread[t] || 0) > 0 && <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-danger align-middle" aria-label="unread" />}
            </button>
          ))}
        </div>
      )}

      {/* column-reverse anchors the scroll at the newest message, even as images/markdown settle. */}
      <div ref={scroller} className="flex flex-1 flex-col-reverse overflow-y-auto">
      <div className="space-y-2 pb-3">
        {loaded && rows.length === 0 && (
          <div className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
            <div className="text-sm text-ink-2">
              {isPrivate
                ? caregiverView
                  ? "Just you and me here — nobody else can see this chat. Ask me what's on the calendar, add something to it, or ask me to order something (Alex or Sam approves purchases)."
                  : "Just you and me here — nobody else can see this chat, and your one-on-one texts with me land here too. Ask me to keep something private (a surprise, a gift idea) and it stays off the family calendar and chat."
                : isMain
                  ? "Hi, I'm Kimi! Ask me about the schedule, hand me a task, or send a photo or PDF and I'll file it."
                  : `A chat for ${threadPeople(thread, myId).replace(/^You/, "you")}, and me. Everyone here sees everything in it — plan a pickup, swap a day, or ask me to put something on the calendar.`}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => send(ex)} className="rounded-full bg-fill px-3 py-1.5 text-xs font-medium text-ink-2 active:bg-fill">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {hidden > 0 && (
          <div className="flex justify-center py-1">
            <button type="button" onClick={() => setShown((n) => n + PAGE)} className="min-h-[36px] rounded-full bg-fill px-3.5 text-xs font-medium text-ink-2 active:opacity-70">
              Show earlier messages
            </button>
          </div>
        )}
        {visible.map((row, idx) => {
          const i = hidden + idx; // stable key: position in the whole thread
          if (row.kind === "tools")
            return (
              <details key={i} className="px-2 text-[11px] text-ink-3">
                <summary className="cursor-pointer select-none">
                  Looked up {row.entries.length} thing{row.entries.length > 1 ? "s" : ""}
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  {row.entries.map((e, j) => (
                    <li key={j} className="break-words">{e.text}</li>
                  ))}
                </ul>
              </details>
            );
          if (row.kind === "msg") {
            const e = row.entry;
            const mine = e.kind === "user";
            const k = `${e.at}|${e.kind}`;
            const rx = e.reactions || [];
            const myEmoji = rx.find((r) => r.by === me)?.emoji;
            return (
              <div key={i} className={`relative flex items-end gap-2 ${mine ? "justify-end" : "justify-start"} ${rx.length ? "pb-3" : ""}`}>
                {!mine && <KimiAvatar size={26} className="mb-0.5" />}
                <div
                  className={`relative max-w-[85%] break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed [@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none] ${mine ? "whitespace-pre-wrap bg-accent text-white" : "bg-surface text-ink shadow-sm ring-1 ring-line"}`}
                  onPointerDown={(ev) => holdStart(k, ev)}
                  onPointerMove={holdMove}
                  onPointerUp={holdEnd}
                  onPointerLeave={holdEnd}
                  onPointerCancel={holdEnd}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setPicker(k);
                  }}
                >
                  {mine && e.who && e.who !== "You" && <div className="mb-0.5 text-[10px] font-semibold opacity-70">{e.who}</div>}
                  {mine ? e.text : <Markdown text={e.text} />}
                  {rx.length > 0 && (
                    <div
                      className={`absolute -bottom-3 z-10 ${mine ? "left-2" : "right-2"} flex items-center gap-0.5 rounded-full bg-surface px-1.5 py-0.5 text-[13px] leading-none shadow-sm ring-1 ring-line`}
                      title={rx.map((r) => `${who(r.by)} ${r.emoji}`).join(" · ")}
                    >
                      {rx.map((r) => (
                        <span key={r.by}>{r.emoji}</span>
                      ))}
                      {rx.length > 1 && <span className="ml-0.5 text-[10px] font-semibold text-ink-3">{rx.length}</span>}
                    </div>
                  )}
                </div>
                {picker === k && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setPicker(null)} />
                    <div className={`absolute -top-11 z-40 flex items-center gap-0.5 rounded-full bg-surface p-1 shadow-lg ring-1 ring-line ${mine ? "right-0" : "left-8"}`} role="menu" aria-label="React">
                      {REACTIONS.map((emo) => (
                        <button
                          key={emo}
                          type="button"
                          role="menuitem"
                          aria-label={`React ${emo}`}
                          onClick={() => react(e, emo)}
                          className={`flex h-9 w-9 items-center justify-center rounded-full text-[19px] ${myEmoji === emo ? "bg-accent/15" : "active:bg-fill"}`}
                        >
                          {emo}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(e.text).catch(() => {});
                          setPicker(null);
                        }}
                        className="ml-0.5 rounded-full px-2.5 py-1.5 text-[12px] font-semibold text-ink-2 active:bg-fill"
                      >
                        Copy
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          }
          if (row.kind === "file")
            return (
              <InlineCard key={i} icon="📄" label="File" at={row.at}>
                <a href={row.f.url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-accent">
                  {row.f.title}
                </a>
              </InlineCard>
            );
          if (row.kind === "task") {
            const s = STATUS[row.t.status] || { label: row.t.status, cls: "bg-fill text-ink-3" };
            return (
              <InlineCard key={i} icon="🖥️" label="Browser task" at={row.at} pill={s}>
                <div className="text-sm font-medium text-ink">{row.t.title}</div>
                {row.t.lastReply && row.t.status !== "done" && <div className="mt-0.5 line-clamp-2 text-xs text-ink-3">{row.t.lastReply}</div>}
                {(row.t.status === "running" || row.t.status === "waiting") && (
                  <div className="mt-2 flex items-center gap-2">
                    <Button size="sm" variant="danger" onClick={() => stopTask(row.t.id)}>
                      Stop
                    </Button>
                    <span className="text-[11px] text-ink-3">Started {fmtDateTime(row.at)}</span>
                  </div>
                )}
              </InlineCard>
            );
          }
          const a = row.a;
          const isEmail = a.kind === "send_email";
          const email = isEmail ? (a.payload as EmailPayload) : null;
          const step = !isEmail ? (a.payload as StepPayload) : null;
          const s = STATUS[a.status] || { label: a.status, cls: "bg-fill text-ink-3" };
          const expanded = open === a.id;
          return (
            <InlineCard key={i} icon={isEmail ? "✉️" : "🖥️"} label={isEmail ? "Email" : "Approval"} at={row.at} pill={s}>
              <div className="text-sm font-medium text-ink">{isEmail ? a.title : step!.description}</div>
              {email && <div className="mt-0.5 text-xs text-ink-3">To: {email.to.join(", ")}</div>}
              {a.status === "proposed" && (
                <>
                  {(email || step?.hasScreenshot || step?.screenshot) && (
                    <button onClick={() => setOpen(expanded ? null : a.id)} className="mt-1 text-xs font-medium text-accent">
                      {expanded ? "Hide" : email ? "Read the draft" : "See the page"}
                    </button>
                  )}
                  {expanded && email && (
                    <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-fill p-2 font-sans text-xs text-ink-2">
                      <b>Subject:</b> {email.subject}
                      {"\n\n"}
                      {email.body}
                    </pre>
                  )}
                  {expanded && (step?.hasScreenshot || step?.screenshot) && <img src={`/api/action?id=${a.id}&shot=1`} alt="" className="mt-1 w-full rounded-lg ring-1 ring-line" />}
                  {caregiverView ? (
                    <div className="mt-1 text-xs text-ink-3">Waiting for Alex or Sam to approve.</div>
                  ) : (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => decideAction(a.id, "approve")} className="bg-ok active:bg-ok">
                        {isEmail ? "Approve & send" : "Approve"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => decideAction(a.id, "decline")}>
                        Decline
                      </Button>
                    </div>
                  )}
                </>
              )}
              {a.status !== "proposed" && (a.result || a.error) && <div className="mt-0.5 text-xs text-ink-3">{a.result || a.error}</div>}
            </InlineCard>
          );
        })}

        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-surface px-3.5 py-2 text-sm text-ink-3 shadow-sm ring-1 ring-line">{atts.length ? "Filing…" : "Thinking…"}</div>
          </div>
        )}
        {note && <div className={`px-2 text-xs ${note.kind === "error" ? "text-danger" : "text-ink-3"}`}>{note.text}</div>}
      </div>
      </div>

      <div className="rounded-2xl bg-surface p-2 shadow-sm ring-1 ring-line">
        {atts.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {atts.map((a, i) => (
              <div key={i} className="relative">
                {a.kind === "image" ? (
                  <img src={a.dataUrl} alt="" className="h-14 w-14 rounded-lg object-cover ring-1 ring-line" />
                ) : (
                  <div className="flex h-14 w-24 flex-col items-center justify-center rounded-lg bg-fill px-2 ring-1 ring-line">
                    <span>📄</span>
                    <span className="w-full truncate text-center text-[10px] text-ink-3">{a.name || "PDF"}</span>
                  </div>
                )}
                <button onClick={() => setAtts((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove attachment" className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs text-white">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <button onClick={() => fileRef.current?.click()} disabled={atts.length >= MAX_ATTACHMENTS} aria-label="Attach a photo or PDF" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl text-ink-3 hover:bg-fill disabled:opacity-40">
            <Icon name="paperclip" className="h-[22px] w-[22px]" />
          </button>
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            placeholder={atts.length ? "Add a note (optional)…" : "Message Kimi…"}
            aria-label="Message"
            className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl bg-fill px-3 py-2.5 text-sm leading-relaxed focus:outline-none"
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter(isAttachable);
              if (files.length) addFiles(files);
            }}
            enterKeyHint="enter"
            onKeyDown={(e) => {
              // Return is a line break. Only Send sends (⌘/Ctrl+Return as a keyboard shortcut).
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button onClick={() => send()} disabled={busy || (!text.trim() && !atts.length)}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function InlineCard({ icon, label, at, pill, children }: { icon: string; label: string; at: string; pill?: { label: string; cls: string }; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[92%] rounded-2xl bg-surface p-3 shadow-sm ring-1 ring-line">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
        <span aria-hidden className="text-sm leading-none">{icon}</span>
        {label}
        <span className="ml-auto font-medium normal-case tracking-normal">{fmtDateTime(at)}</span>
        {pill && <span className={`rounded-md px-1.5 py-0.5 normal-case tracking-normal ${pill.cls}`}>{pill.label}</span>}
      </div>
      {children}
    </div>
  );
}
