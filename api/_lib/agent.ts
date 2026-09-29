import Anthropic from "@anthropic-ai/sdk";
import {
  getCollection,
  setCollection,
  appendItems,
  getProfile,
  setProfile,
  getTask,
  saveTask,
  getTaskMeta,
  getTaskMetas,
  listActiveTaskIds,
  acquireTaskLock,
  releaseTaskLock,
  redis,
} from "./db.js";
import { profileContext } from "./classify.js";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./calendar.js";
import { notify } from "./notify.js";
import { proposeAction } from "./actions.js";
import { createFile, fileUrl } from "./files.js";
import { searchMail, inboxConfigured } from "./imap.js";
import { gmailConnected, searchGmail } from "./gmail.js";
import * as web from "./browser.js";
import { readUrl } from "./links.js";
import { getWorkCalConfig, getWorkBlocks, formatBlocks } from "./workcal.js";
import { listCredentials, getCredentialField, credentialsAvailable } from "./vault.js";
import { listOpCards, getOpCard, opConfigured, BUSINESS_CARD_RE } from "./onepassword.js";
import { guardCheck, pageFacts } from "./guard.js";
import { summarizeSpending } from "./receipts.js";
import { dayOutlook, windowWeather } from "./weather.js";
import { leaveByTime } from "./travel.js";
import { toHomeZone, homeSortKey, wallToUtc, HOME_TZ, fmt12 } from "../../src/data/tz.js";
import { CONFIG } from "../../src/data/config.js";
import { shortTitle } from "../../src/data/text.js";
import { titlesSimilar, eventsSimilar, todosSimilar, mergeEventDetails } from "./util.js";
import { PREP_CONVENTIONS, NAME_COLLISIONS } from "./conventions.js";
import type { Task, TaskLogEntry, CalEvent, Todo, Channel, StepPayload } from "../../src/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// The assistant's agent loop. Runs a persistent task thread against Claude with
// a tool belt over the family's data, checkpoints the thread to Redis after
// every step, and yields before the serverless deadline so the cron can resume
// it — a resumable "cloud worker" with no separate host.
//
// Two kinds of task: the shared family chat (task-main) and background
// "browser" tasks that drive a real browser and pause for approval before
// anything irreversible.
// ─────────────────────────────────────────────────────────────────────────────

const client = new Anthropic();
const MODEL = process.env.AGENT_MODEL || "claude-opus-5";
export const MAIN_TASK_ID = "task-main";

const nowPT = () =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: HOME_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());

const todayPT = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const addDays = (date: string, n: number) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── Tools ────────────────────────────────────────────────────────────────────

const BASE_TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    name: "get_upcoming",
    description:
      "Look up what's on the family calendar and the open to-dos. Call this BEFORE answering any question about schedules, plans, what's coming up, or what needs doing — never answer those from memory.",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "How many days ahead to include (default 14)." } },
    },
  },
  {
    name: "search",
    description:
      "Full-text search across events, to-dos, contacts, places, and filed messages. Call this when asked about a specific thing by name (a party, a teacher, a flight, a to-do) or when get_upcoming's window is too narrow.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to match (case-insensitive)." } },
      required: ["query"],
    },
  },
  {
    name: "directory",
    description:
      "The family directory: each kid's school/teacher/aftercare, drop-off & pick-up routines, contacts (teachers, aftercare, daycare, friends' parents) with emails/phones, and places. Call this for any who/where/contact question.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_event",
    description:
      "Put a dated event on the family calendar (syncs to Google Calendar and invites Sam). Call this when a parent asks to add/schedule something or tells you about a dated plan that should be on the calendar. Times are Pacific.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        start: { type: "string", description: "HH:mm (24h). Omit for all-day." },
        end: { type: "string", description: "HH:mm (24h), optional" },
        endDate: { type: "string", description: "YYYY-MM-DD if a multi-day all-day span" },
        location: { type: "string" },
        notes: { type: "string", description: "What to bring/wear, confirmation numbers, details" },
        people: { type: "array", items: { type: "string" }, description: 'Who it is FOR: "max","theo","ava","alex","sam" or a guest name' },
        owner: { type: "array", items: { type: "string" }, description: 'Who is RESPONSIBLE: "alex" and/or "sam"' },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "update_event",
    description:
      "Change an existing calendar event: reschedule (date/start/end), retitle, move location, or fix notes. Find the id with get_upcoming or search first. Syncs to Google Calendar. For a change that touches several events, list them and get the parent's OK in chat before calling this for each.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        set: {
          type: "object",
          properties: {
            title: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD" },
            start: { type: "string", description: "HH:mm Pacific; omit to keep" },
            end: { type: "string", description: "HH:mm Pacific" },
            allDay: { type: "boolean" },
            location: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
      required: ["id", "set"],
    },
  },
  {
    name: "delete_events",
    description:
      "Delete calendar events by id (also removes them from Google Calendar). DESTRUCTIVE: unless the parent named exactly one event to delete, first list the matching events (title + date) and ask them to confirm in chat; call this only after they say yes.",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
  },
  {
    name: "add_todo",
    description:
      "Add a to-do for the parents. Call this when asked to remind/track something, or when an event you're filing clearly implies prep (gift, permission slip, RSVP). Owner defaults to both parents.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
        due: { type: "string", description: "YYYY-MM-DD, optional" },
        people: { type: "array", items: { type: "string" } },
        owner: { type: "array", items: { type: "string" } },
        priority: { type: "string", enum: ["normal", "high"] },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_todo",
    description: "Mark a to-do done. Call this when a parent says something is handled/done. Match by id (from get_upcoming/search) or title.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
    },
  },
  {
    name: "remember",
    description:
      "Save a durable household fact to the family's profile so future conversations know it (a preference, an allergy update, a standing arrangement, a vendor, a rule). Call this whenever a parent tells you something worth remembering long-term — not for one-off events.",
    input_schema: {
      type: "object",
      properties: { fact: { type: "string", description: "One clear sentence." } },
      required: ["fact"],
    },
  },
  {
    name: "schedule_followup",
    description:
      "Schedule yourself to check back in later — call this whenever you promise to follow up, remind someone at a time, or re-check something. At that time you'll be woken with the note and are expected to act and message the family.",
    input_schema: {
      type: "object",
      properties: {
        when: { type: "string", description: 'Pacific wall time "YYYY-MM-DD HH:mm", or a date "YYYY-MM-DD" (defaults to 8:00 AM)' },
        note: { type: "string", description: "What to do / remind about at that time." },
      },
      required: ["when", "note"],
    },
  },
  {
    name: "draft_email",
    description:
      "Draft an email to send on a parent's behalf (a teacher, aftercare, a vendor, another parent). It is NOT sent: it becomes a proposal the parents approve in the app's Activity tab (or by replying APPROVE over SMS). Call this when asked to email/write to someone, or when a task clearly needs an outbound email. Look the address up with directory/search first — never guess an address.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses." },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text, in the parent's voice, signed with their first name." },
        why: { type: "string", description: "One line on what this accomplishes." },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "create_file",
    description:
      "Turn a substantial piece of work — a comparison, a plan, an itinerary, research findings, a checklist — into a File: a rendered page with a link the parents can open or share. Call this instead of pasting long structured content into chat. Markdown (headings, tables, lists, links) renders well.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, markdown: { type: "string" } },
      required: ["title", "markdown"],
    },
  },
  {
    name: "search_email",
    description:
      "Search email. account='school' (default) is the dedicated inbox that receives all forwarded school mail — use it for 'did the school say…', permission slips, teacher notes, dates. account='alex' or 'sam' is that parent's own Gmail (if they've connected it) — use it for receipts, orders, invitations, confirmations, subscriptions; Gmail search syntax works (from:, subject:, has:attachment). Returns newest-first date/sender/subject with snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match in sender/subject/body. Omit for 'everything recent'." },
        days: { type: "integer", description: "Lookback window in days (default 30)." },
        account: { type: "string", enum: ["school", "alex", "sam"] },
        limit: { type: "integer", description: "Max results (default 25)." },
      },
    },
  },
  {
    name: "get_spending",
    description:
      "The family's spending log: purchases found in order/payment receipts in both parents' inboxes (merchant, amount, what, which card), including ones Kimi placed. Use for 'how much did we spend on…', 'did the camp payment go through', 'what did you buy'. It's built from receipts, not a bank statement — say so if completeness matters.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD (default: first of this month)" },
        to: { type: "string", description: "YYYY-MM-DD (default: today)" },
        merchant: { type: "string", description: "Filter by merchant or item, e.g. 'Amazon', 'tuition'" },
      },
    },
  },
  {
    name: "prepare_payment",
    description:
      "Set up a Venmo payment to a person (babysitter, class fund, a friend) for the PARENT to complete: returns a link that opens Venmo with the recipient, amount, and note filled in. You never send money yourself. Looks up the person's Venmo username in the household directory; if it's missing, ask the parent for it and pass it as `venmo` (it's saved for next time).",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Person's name as in the directory" },
        amount: { type: "number" },
        note: { type: "string", description: "What it's for, e.g. 'Babysitting Sat 6–10pm'" },
        venmo: { type: "string", description: "Venmo username if not in the directory (without @)" },
      },
      required: ["to", "amount", "note"],
    },
  },
  {
    name: "get_weather",
    description:
      "Forecast for home (US National Weather Service, ~7 days ahead): a daily outlook, and hour-by-hour for a specific time window. Use for outdoor events, what to wear/bring, and planning around rain or heat.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD (default today)" },
        days: { type: "integer", description: "How many days of outlook (default 1, max 7)" },
        start: { type: "string", description: "HH:mm — with `end`, the weather during that window on `date`" },
        end: { type: "string", description: "HH:mm" },
      },
    },
  },
  {
    name: "get_work_calendar",
    description:
      "Read Alex's and/or Sam's WORK calendar (read-only planning context — never copy these into the family calendar). Use it for daily/weekly planning, finding a time that works, spotting conflicts between kid events and work, and vacation planning (who's out, which weeks are heavy). Returns meetings by day in Pacific time; 'Busy' means only free/busy is shared.",
    input_schema: {
      type: "object",
      properties: {
        who: { type: "string", enum: ["alex", "sam", "both"] },
        from: { type: "string", description: "YYYY-MM-DD (default today)" },
        days: { type: "integer", description: "How many days (default 7, max 60)" },
      },
    },
  },
  {
    name: "read_link",
    description:
      "Read a specific page by URL — an invitation (Paperless Post, Evite, Punchbowl…), a sign-up sheet, a school notice, a Google Doc — including ones that need JavaScript. Use it on links found in events' notes or emails to check details or status (e.g. whether the family already RSVP'd). Returns the page text.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  { type: "web_search_20260209", name: "web_search", max_uses: 6 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 },
];

// Only in the family chat: hand a job to a background browser task.
const CHAT_ONLY_TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    name: "start_browser_task",
    description:
      "Hand a job that needs a real web browser to a background task: registering for a camp/class, booking or cancelling something, filling a form on a website, checking an account, changing a subscription. The task runs on its own, pauses to ask the parents before anything irreversible (payments, bookings, submissions), and messages them when done. Call this when the request can't be done with the other tools. Give a complete, self-contained goal — the task cannot ask you follow-up questions.",
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "One clear sentence: what outcome to achieve." },
        details: { type: "string", description: "Everything the task needs: site/URL if known, names, dates, options, constraints, budget cap, which saved login to use." },
      },
      required: ["goal"],
    },
  },
];

const RESUME_TOOL: Anthropic.Messages.ToolUnion = {
  name: "resume_browser_task",
  description:
    "Continue an EXISTING background browser task with new information or instructions — a verification code the parent just sent, an answer to a question the task asked, a tweak to the goal. Keeps the task's browser session, login state, and any approval already granted. Use this instead of start_browser_task whenever a browser task is already in progress for the same job.",
  input_schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task id (task-web-…) from the earlier start_browser_task result or the thread." },
      instructions: { type: "string", description: "What to do now, complete and self-contained (include the code / answer verbatim)." },
    },
    required: ["taskId", "instructions"],
  },
};
CHAT_ONLY_TOOLS.push(RESUME_TOOL);
CHAT_ONLY_TOOLS.push({
  name: "stop_browser_task",
  description: "Stop a background browser task that the parent wants cancelled or that is clearly stuck. Releases its browser and declines any approval it was waiting on.",
  input_schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
});

// Only in browser tasks: the hands.
const BROWSER_TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    name: "browse_goto",
    description: "Open a URL in the browser. Then call browse_read to see the page.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browse_read",
    description:
      "Read the current page: URL, title, a numbered list of interactive elements ([n] buttons/links/inputs with their labels and current values) and the visible text. Call this after EVERY navigation or action to see what happened — never assume an action worked.",
    input_schema: { type: "object", properties: { maxText: { type: "integer", description: "Max characters of page text (default 6000)." } } },
  },
  {
    name: "browse_click",
    description:
      "Click element [n] from browse_read. Irreversible-looking buttons (pay, book, confirm, register, submit, cancel…) are BLOCKED until a parent has approved via request_approval.",
    input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  },
  {
    name: "browse_type",
    description: "Replace the contents of input/textarea [n] with text. Set pressEnter for search boxes.",
    input_schema: {
      type: "object",
      properties: { n: { type: "integer" }, text: { type: "string" }, pressEnter: { type: "boolean" } },
      required: ["n", "text"],
    },
  },
  {
    name: "browse_select",
    description: "Choose an option in <select> [n] by value or visible label.",
    input_schema: { type: "object", properties: { n: { type: "integer" }, value: { type: "string" } }, required: ["n", "value"] },
  },
  {
    name: "browse_press",
    description: 'Press a keyboard key (e.g. "Enter", "Escape", "Tab", "PageDown").',
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browse_screenshot",
    description: "Take a screenshot of the visible page. Use when layout matters (calendars, seat maps, image-only content) or the text is ambiguous. Prefer browse_read otherwise — it's cheaper.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_credentials",
    description: "List the logins you may use (name, site, username; some also have a one-time code) — the family's 1Password “Family HQ” vault plus any saved locally. Call before logging in anywhere and use the exact name shown.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browse_fill_credential",
    description:
      "Fill a login field with a saved credential WITHOUT you seeing it: field='username', 'password', or 'otp' (the current one-time code, for sites that ask for an authenticator code) from login `name` into element [n]. Use this for every login; never ask for or type passwords yourself.",
    input_schema: {
      type: "object",
      properties: { n: { type: "integer" }, name: { type: "string" }, field: { type: "string", enum: ["username", "password", "otp"] } },
      required: ["n", "name", "field"],
    },
  },
  {
    name: "list_cards",
    description:
      "List the payment cards you may use from the family's 1Password vault: name, brand, last four digits, and whether it's a company card. You never see the full number.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browse_fill_card",
    description:
      "Enter a payment card into the checkout form WITHOUT you seeing it: number, expiry, security code, and (if the form asks) cardholder name and billing ZIP. Finds the card fields itself, including inside payment-provider frames. Only after a parent approved this purchase with THIS card named in request_approval. Never type card numbers yourself.",
    input_schema: { type: "object", properties: { card: { type: "string", description: "Card name exactly as list_cards shows it." } }, required: ["card"] },
  },
  {
    name: "request_approval",
    description:
      "REQUIRED before any irreversible step: paying, placing an order, booking, registering, submitting a form with personal data, cancelling, or sending a message. Describe EXACTLY what will happen (item, amount, date/time, recipient, account). The task pauses until a parent approves or declines; you'll be woken with the decision.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Precise: 'Pay $185 to City Parks & Rec for Max — Fall Soccer (Sat 10am) with the card saved on the site.'" },
        includeScreenshot: { type: "boolean", description: "Attach a screenshot of the page (default true)." },
      },
      required: ["description"],
    },
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Buttons that commit something in the world. Over-blocking costs one approval
// round; under-blocking costs money — err toward blocking.
// Only the click that actually commits money / a booking / a submission is
// gated. Getting TO that click (checkout, review, continue) is not.
const COMMIT_RE = /\b(pay now|pay \$|make payment|complete payment|purchase|buy now|place (your |my |the )?order|order now|confirm (purchase|payment|booking|order|registration|reservation|appointment)|complete (order|purchase|booking|registration|enrollment|reservation)|book now|reserve now|register now|enroll now|sign ?up now|submit (order|payment|registration|application|enrollment|rsvp)|cancel (subscription|order|membership|booking|reservation|plan)|unsubscribe|delete (my )?account|send message|send email)\b/i;
const SAFE_RE = /\b(search|filter|sort|sign in|log ?in|next|continue|proceed|checkout|check out|review|add to cart|close|dismiss|accept (all )?cookies|got it|show more|load more|view|details|edit|change|back)\b/i;

// ── Tool execution ───────────────────────────────────────────────────────────

interface RunCtx {
  task: Task;
  handle: web.BrowserHandle | null;
}
type ToolOut = string | Anthropic.ToolResultBlockParam["content"];

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** The parent's own words behind a task — trusted input for the safety check. */
function parentRequestOf(task: Task): string {
  if (task.parentRequest) return task.parentRequest;
  const first = (task.thread as Anthropic.MessageParam[]).find((m) => m.role === "user");
  if (!first) return "";
  return typeof first.content === "string" ? first.content : first.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

/** The parent's recent words in a chat thread (and the assistant message they answered). */
function recentParentWords(task: Task): string {
  const msgs = task.thread as Anthropic.MessageParam[];
  const textOfMsg = (m: Anthropic.MessageParam) => (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ")).trim();
  const out: string[] = [];
  let users = 0;
  for (let i = msgs.length - 1; i >= 0 && users < 3; i--) {
    const m = msgs[i];
    if (m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"))) {
      out.unshift(`PARENT: ${textOfMsg(m).slice(0, 600)}`);
      users++;
      // The assistant message this was replying to (what the parent saw and agreed to).
      for (let j = i - 1; j >= 0; j--) {
        const a = msgs[j];
        if (a.role === "assistant" && typeof a.content !== "string" && a.content.some((b) => b.type === "text")) {
          if (users === 1) out.unshift(`ASSISTANT (what the parent was replying to): ${textOfMsg(a).slice(0, 600)}`);
          break;
        }
      }
    }
  }
  return out.join("\n");
}

async function ensureBrowser(ctx: RunCtx): Promise<web.BrowserHandle> {
  if (!ctx.handle) {
    ctx.handle = await web.openBrowser(ctx.task.browserSessionId);
    ctx.task.browserSessionId = ctx.handle.sessionId;
  }
  return ctx.handle;
}

const fmtEvent = (e: CalEvent) => {
  const t = toHomeZone(e);
  const when = e.allDay
    ? `${t.date}${e.endDate && e.endDate !== e.date ? `→${e.endDate}` : ""} (all day)`
    : `${t.date} ${fmt12(t.start)}${t.end ? `–${fmt12(t.end)}` : ""}`;
  const drive = !e.allDay && t.start && e.travelMin && e.travelMin >= 10 && e.travelMin <= 180 ? ` · ~${e.travelMin} min drive, leave by ${fmt12(leaveByTime(t.start, e.travelMin))}` : "";
  return `• [${e.id}] ${when} — ${e.title}${e.location ? ` @ ${e.location}` : ""}${drive}${e.prep ? ` · notes: ${e.prep.slice(0, 120)}` : ""}${
    e.people?.length ? ` · for ${e.people.join(",")}` : ""
  }`;
};
const fmtTodo = (t: Todo) =>
  `• [${t.id}] ${t.title}${t.due ? ` (due ${t.due})` : ""}${t.priority === "high" ? " HIGH" : ""}${t.owner?.length ? ` · resp ${t.owner.join(",")}` : ""}${
    t.detail ? ` · ${t.detail.slice(0, 100)}` : ""
  }`;

async function runTool(name: string, input: any, ctx: RunCtx): Promise<ToolOut> {
  const { task } = ctx;
  const today = todayPT();
  switch (name) {
    case "get_upcoming": {
      const days = Math.min(Math.max(Number(input?.days) || 14, 1), 120);
      const to = addDays(today, days);
      const events = (await getCollection("events"))
        .filter((e) => {
          const d = toHomeZone(e).date;
          return d >= today && d <= to;
        })
        .sort((a, b) => homeSortKey(a).localeCompare(homeSortKey(b)));
      const todos = (await getCollection("todos"))
        .filter((t) => !t.done)
        .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
      return [
        `Today (PT): ${today}. Events in the next ${days} days:`,
        ...(events.length ? events.map(fmtEvent) : ["(none)"]),
        "",
        `Open to-dos (${todos.length}):`,
        ...(todos.length ? todos.slice(0, 40).map(fmtTodo) : ["(none)"]),
      ].join("\n");
    }
    case "search": {
      const q = String(input?.query || "").toLowerCase();
      if (!q) return "empty query";
      const [events, todos, contacts, places, comms] = await Promise.all([
        getCollection("events"),
        getCollection("todos"),
        getCollection("contacts"),
        getCollection("places"),
        getCollection("comms"),
      ]);
      const hit = (s?: string) => (s || "").toLowerCase().includes(q);
      const out: string[] = [];
      const ev = events.filter((e) => hit(e.title) || hit(e.location) || hit(e.prep)).slice(-10);
      if (ev.length) out.push("Events:", ...ev.map(fmtEvent));
      const td = todos.filter((t) => hit(t.title) || hit(t.detail)).slice(-10);
      if (td.length) out.push("To-dos:", ...td.map((t) => fmtTodo(t) + (t.done ? " (done)" : "")));
      const ct = contacts.filter((c) => hit(c.name) || hit(c.role) || hit(c.org)).slice(0, 10);
      if (ct.length) out.push("Contacts:", ...ct.map((c) => `• ${c.name} — ${c.role}${c.email ? ` · ${c.email}` : ""}${c.phone ? ` · ${c.phone}` : ""}`));
      const pl = places.filter((p) => hit(p.name) || hit(p.notes)).slice(0, 5);
      if (pl.length) out.push("Places:", ...pl.map((p) => `• ${p.name}${p.phone ? ` · ${p.phone}` : ""}${p.notes ? ` · ${p.notes}` : ""}`));
      const cm = comms.filter((c) => hit(c.subject) || hit(c.summary)).slice(-6);
      if (cm.length) out.push("Filed messages:", ...cm.map((c) => `• ${c.receivedAt.slice(0, 10)} ${c.subject}: ${c.summary}`));
      return out.length ? out.join("\n") : `Nothing matched "${q}".`;
    }
    case "directory": {
      const [kids, contacts, places, routines] = await Promise.all([
        getCollection("kids"),
        getCollection("contacts"),
        getCollection("places"),
        getCollection("routines"),
      ]);
      const out: string[] = ["Kids:"];
      for (const k of kids) {
        out.push(`• ${k.firstName} (${k.id}) — ${k.current.program} @ ${k.current.school}, teacher(s) ${k.current.teachers.join(", ")}${k.current.aftercare ? `; after school: ${k.current.aftercare}` : ""}`);
        for (const r of routines.filter((r) => r.kidId === k.id)) out.push(`    ${r.label}: ${r.detail}`);
      }
      out.push("Contacts:");
      for (const c of contacts) out.push(`• ${c.name} — ${c.role}${c.email ? ` · ${c.email}` : ""}${c.phone ? ` · ${c.phone}` : ""}${c.kidIds?.length ? ` · ${c.kidIds.join(",")}` : ""}`);
      out.push("Places:");
      for (const p of places) out.push(`• ${p.name}${p.phone ? ` · ${p.phone}` : ""}${p.address ? ` · ${p.address}` : ""}${p.notes ? ` · ${p.notes}` : ""}`);
      return out.join("\n");
    }
    case "add_event": {
      const start = input?.start || undefined;
      const evt: CalEvent = {
        id: `evt-chat-${Date.now().toString(36)}`,
        title: String(input?.title || "").trim(),
        date: String(input?.date || ""),
        start,
        end: input?.end || undefined,
        endDate: input?.endDate || undefined,
        allDay: !start,
        location: input?.location || undefined,
        prep: input?.notes || undefined,
        people: Array.isArray(input?.people) ? input.people : [],
        owner: Array.isArray(input?.owner) ? input.owner : [],
        source: "other",
      };
      if (!evt.title || !/^\d{4}-\d{2}-\d{2}$/.test(evt.date)) return "error: title and date (YYYY-MM-DD) required";
      // Already on the calendar (from an email, the calendar mirror, or earlier in
      // chat)? Update that one instead of adding a second copy.
      const events = await getCollection("events");
      const existing = events.find((x) => eventsSimilar(x, evt) || (x.date === evt.date && !!x.start && x.start === evt.start && titlesSimilar(x.title, evt.title)));
      if (existing) {
        mergeEventDetails(existing, { ...evt, title: undefined, people: evt.people?.length ? evt.people : undefined, owner: evt.owner?.length ? evt.owner : undefined });
        try {
          await updateCalendarEvent(existing, { silent: true });
        } catch (e) {
          console.error("agent add_event→update gcal failed", e);
        }
        await setCollection("events", events);
        return `Already on the calendar — updated it instead of adding a duplicate: ${fmtEvent(existing)}`;
      }
      try {
        const gcalId = await createCalendarEvent(evt);
        if (gcalId) evt.gcalId = gcalId;
      } catch (e) {
        console.error("agent add_event gcal failed", e);
      }
      await appendItems("events", [evt]);
      return `Added: ${fmtEvent(evt)}${evt.gcalId ? " (on Google Calendar)" : ""}`;
    }
    case "update_event": {
      const events = await getCollection("events");
      const evt = events.find((e) => e.id === input?.id);
      if (!evt) return `error: no event with id ${input?.id}`;
      const set = input?.set || {};
      if (set.title) evt.title = String(set.title).trim();
      if (set.date && /^\d{4}-\d{2}-\d{2}$/.test(set.date)) evt.date = set.date;
      if (set.start !== undefined) evt.start = set.start || undefined;
      if (set.end !== undefined) evt.end = set.end || undefined;
      if (typeof set.allDay === "boolean") evt.allDay = set.allDay;
      if (set.start) evt.allDay = false;
      if (evt.allDay) {
        evt.start = undefined;
        evt.end = undefined;
      } else {
        // Times given by the assistant are Pacific wall-clock.
        evt.startTz = HOME_TZ;
        evt.endTz = HOME_TZ;
        evt.endDate = undefined;
      }
      if (set.location !== undefined) evt.location = set.location || undefined;
      if (set.notes !== undefined) evt.prep = set.notes || undefined;
      try {
        const gcalId = await updateCalendarEvent(evt, { silent: true });
        if (gcalId) evt.gcalId = gcalId;
      } catch (e) {
        console.error("agent update_event gcal failed", e);
      }
      await setCollection("events", events);
      return `Updated: ${fmtEvent(evt)}`;
    }
    case "delete_events": {
      const ids: string[] = Array.isArray(input?.ids) ? input.ids.map(String) : [];
      if (!ids.length) return "error: ids required";
      const events = await getCollection("events");
      const gone = events.filter((e) => ids.includes(e.id));
      if (!gone.length) return "error: no matching events";
      for (const e of gone) if (e.gcalId) await deleteCalendarEvent(e.gcalId).catch(() => {});
      await setCollection("events", events.filter((e) => !ids.includes(e.id)));
      return `Deleted ${gone.length} event${gone.length > 1 ? "s" : ""}: ${gone.map((e) => `${e.title} (${e.date})`).join("; ")}`;
    }
    case "add_todo": {
      const owner = Array.isArray(input?.owner) && input.owner.length ? input.owner : ["alex", "sam"];
      const todo: Todo = {
        id: `todo-chat-${Date.now().toString(36)}`,
        title: String(input?.title || "").trim(),
        detail: input?.detail || undefined,
        due: input?.due || undefined,
        people: Array.isArray(input?.people) ? input.people : [],
        owner,
        priority: input?.priority === "high" ? "high" : "normal",
        done: false,
        source: "other",
      };
      if (!todo.title) return "error: title required";
      const dup = (await getCollection("todos")).find((x) => !x.done && todosSimilar(x, todo));
      if (dup) return `Already tracked — not adding a duplicate: ${fmtTodo(dup)}`;
      await appendItems("todos", [todo]);
      return `Added to-do: ${fmtTodo(todo)}`;
    }
    case "complete_todo": {
      const todos = await getCollection("todos");
      const q = String(input?.title || "").toLowerCase();
      const t = todos.find((x) => x.id === input?.id) || (q ? todos.find((x) => !x.done && x.title.toLowerCase().includes(q)) : undefined);
      if (!t) return "error: no matching open to-do";
      t.done = true;
      await setCollection("todos", todos);
      return `Marked done: ${t.title}`;
    }
    case "remember": {
      const fact = String(input?.fact || "").trim();
      if (!fact) return "error: fact required";
      const profile = await getProfile();
      let sec = profile.sections.find((s) => s.key === "learned");
      if (!sec) {
        sec = { key: "learned", title: "Learned facts", body: "" };
        profile.sections.push(sec);
      }
      sec.body = `${sec.body ? sec.body + "\n" : ""}- ${fact} (${today})`;
      await setProfile(profile);
      return `Remembered: ${fact}`;
    }
    case "schedule_followup": {
      const when = String(input?.when || "").trim();
      const m = when.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
      if (!m) return 'error: when must be "YYYY-MM-DD HH:mm" or "YYYY-MM-DD"';
      const at = wallToUtc(m[1], m[2] || "08:00", HOME_TZ);
      if (at.getTime() < Date.now() - 60_000) return "error: that time is in the past";
      task.nextCheckAt = at.toISOString();
      task.followupNote = String(input?.note || "").trim();
      task.status = "waiting";
      return `Follow-up scheduled for ${m[1]} ${m[2] || "08:00"} PT: ${task.followupNote}`;
    }
    case "draft_email": {
      const to = (Array.isArray(input?.to) ? input.to : []).map((x: unknown) => String(x).trim()).filter((x: string) => EMAIL_RE.test(x));
      if (!to.length) return "error: at least one valid recipient email is required — look it up with directory or search";
      const cc = (Array.isArray(input?.cc) ? input.cc : []).map((x: unknown) => String(x).trim()).filter((x: string) => EMAIL_RE.test(x));
      const subject = String(input?.subject || "").trim();
      const body = String(input?.body || "").trim();
      if (!subject || !body) return "error: subject and body required";
      const a = await proposeAction({
        kind: "send_email",
        title: `Email ${to.join(", ")} — ${subject}`,
        summary: String(input?.why || "").trim() || subject,
        payload: { to, cc: cc.length ? cc : undefined, subject, body },
        taskId: task.id,
        requestedBy: task.owner,
        channel: task.channel,
      });
      return `Drafted (${a.id}) — NOT sent. Waiting for a parent's approval${
        task.channel === "sms" ? " (reply APPROVE to send, DECLINE to drop)" : " in the app's Activity tab"
      }.`;
    }
    case "create_file": {
      const title = String(input?.title || "").trim();
      const markdown = String(input?.markdown || "").trim();
      if (!title || !markdown) return "error: title and markdown required";
      const doc = await createFile({ title, markdown, taskId: task.id });
      return `File created: "${doc.title}" → ${fileUrl(doc)} (private to the family; share it from the Activity tab)`;
    }
    case "get_spending": {
      const today = todayPT();
      const from = /^\d{4}-\d{2}-\d{2}$/.test(input?.from || "") ? input.from : `${today.slice(0, 7)}-01`;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(input?.to || "") ? input.to : today;
      return summarizeSpending(await getCollection("spending"), { from, to, merchant: input?.merchant ? String(input.merchant) : undefined });
    }
    case "prepare_payment": {
      const toName = String(input?.to || "").trim();
      const amount = Math.round(Number(input?.amount) * 100) / 100;
      const note = String(input?.note || "").trim().slice(0, 140);
      if (!toName || !(amount > 0) || !note) return "error: to, amount (> 0), and note are required";
      const want = toName.toLowerCase();
      const profile = await getProfile();
      const contacts = await getCollection("contacts");
      const person = profile.people.find((p) => p.name.toLowerCase() === want) || profile.people.find((p) => p.name.toLowerCase().includes(want));
      const contact = person ? undefined : contacts.find((c) => c.name.toLowerCase() === want) || contacts.find((c) => c.name.toLowerCase().includes(want));
      const given = String(input?.venmo || "").trim().replace(/^@/, "");
      if (given && !/^[A-Za-z0-9_-]{2,40}$/.test(given)) return "error: that doesn't look like a Venmo username (letters, numbers, - and _ only)";
      let handle = given || person?.venmo || contact?.venmo || "";
      if (!handle) return `No Venmo username on file for ${person?.name || contact?.name || toName}. Ask the parent for it, then call prepare_payment again with venmo set.`;
      let saved = "";
      if (given && person && person.venmo !== given) {
        person.venmo = given;
        await setProfile(profile);
        saved = `Saved @${given} on ${person.name}'s entry in the household directory.`;
      } else if (given && contact && contact.venmo !== given) {
        contact.venmo = given;
        await setCollection("contacts", contacts);
        saved = `Saved @${given} on ${contact.name}'s contact.`;
      } else if (given && !person && !contact) {
        saved = `NOT saved: ${toName} isn't in the household directory, so the username wasn't stored. Say so; they can add the person under Household to keep it.`;
      }
      handle = handle.replace(/^@/, "");
      const url = `https://venmo.com/${encodeURIComponent(handle)}?txn=pay&audience=private&amount=${amount.toFixed(2)}&note=${encodeURIComponent(note)}`;
      const who = person?.name || contact?.name || toName;
      return `Payment ready for the parent to complete in Venmo (you did NOT send anything). Include this link as-is in your reply:\n[Pay ${who} $${amount.toFixed(2)} in Venmo](${url})\nTell them to check the amount and recipient (@${handle}) in Venmo before confirming.${saved ? `\n${saved}` : ""}`;
    }
    case "get_weather": {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(input?.date || "") ? input.date : todayPT();
      try {
        if (/^\d{2}:\d{2}$/.test(input?.start || "")) {
          const w = await windowWeather(date, input.start, /^\d{2}:\d{2}$/.test(input?.end || "") ? input.end : undefined);
          return w ? `${date} ${input.start}${input?.end ? `–${input.end}` : ""}: ${w.short}, ${w.minF}–${w.maxF}°F, rain chance up to ${w.pop}%.` : `No forecast for ${date} yet (the forecast covers about 7 days).`;
        }
        const days = Math.min(Math.max(Number(input?.days) || 1, 1), 7);
        const out: string[] = [];
        for (let i = 0; i < days; i++) {
          const d = new Date(Date.parse(`${date}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
          const o = await dayOutlook(d);
          out.push(`${d}: ${o || "beyond the forecast range"}`);
        }
        return `Home forecast (daytime):\n${out.join("\n")}`;
      } catch (e) {
        return `error: weather unavailable (${String((e as Error).message || e).slice(0, 100)})`;
      }
    }
    case "get_work_calendar": {
      const who = input?.who === "alex" || input?.who === "sam" ? [input.who as "alex" | "sam"] : (["alex", "sam"] as const);
      const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(input?.from || "") ? input.from : todayPT();
      const days = Math.min(Math.max(Number(input?.days) || 7, 1), 60);
      const from = wallToUtc(fromDate, "00:00", HOME_TZ);
      const to = new Date(+from + days * 86400000);
      const out: string[] = [];
      for (const p of who) {
        const name = p === "alex" ? "Alex" : "Sam";
        if (!(await getWorkCalConfig(p))) {
          out.push(`${name}: work calendar not connected (Kimi tab → Connections).`);
          continue;
        }
        try {
          out.push(`${name}'s work calendar:\n${formatBlocks(await getWorkBlocks(p, from, to))}`);
        } catch (e) {
          out.push(`${name}: couldn't read the work calendar (${String((e as Error).message || e).slice(0, 120)}).`);
        }
      }
      return out.join("\n\n");
    }
    case "read_link": {
      const url = String(input?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return "error: url must start with http(s)://";
      const text = await readUrl(url).catch((e) => `error: ${String(e).slice(0, 200)}`);
      return text ? text.slice(0, 8000) : "error: the page returned no readable text";
    }
    case "search_email": {
      const raw = String(input?.account || "school");
      const account = raw === "personal" ? "alex" : raw === "alex" || raw === "sam" ? raw : "school";
      const days = Number(input?.days) || 30;
      const limit = Number(input?.limit) || 25;
      let hits;
      const other = account === "alex" ? "sam" : "alex";
      if (account === "school") hits = await searchMail({ query: input?.query, days, account: "school", limit });
      else if (inboxConfigured(account)) hits = await searchMail({ query: input?.query, days, account, limit });
      else if (await gmailConnected(account)) hits = await searchGmail(account, { query: input?.query, days, limit });
      else return `error: ${account === "alex" ? "Alex" : "Sam"}'s Gmail isn't connected yet. Only the school inbox${inboxConfigured(other) || (await gmailConnected(other)) ? ` and ${other === "alex" ? "Alex" : "Sam"}'s Gmail` : ""} can be searched.`;
      if (!hits.length) return `No ${account} emails matched${input?.query ? ` "${input.query}"` : ""} in the last ${days} days.`;
      return hits.map((h) => `• ${h.date.slice(0, 10)} | ${h.from} | ${h.subject}${h.snippet ? ` — ${h.snippet}` : ""}`).join("\n");
    }

    // ── chat-only ──
    case "resume_browser_task": {
      const id = String(input?.taskId || "").trim();
      const instructions = String(input?.instructions || "").trim();
      const child = id ? await getTask(id) : null;
      if (!child || child.kind !== "browser") return `error: no browser task ${id || "(none given)"}`;
      if (!instructions) return "error: instructions required";
      const who = task.owner === "alex" ? "Alex" : "Sam";
      (child.thread as Anthropic.MessageParam[]).push({ role: "user", content: `[${who} · ${task.channel} · ${nowPT()} PT]\n${instructions}` });
      pushLog(child, { at: new Date().toISOString(), kind: "user", who, text: instructions });
      child.waitingOn = undefined;
      child.status = "running";
      child.nextCheckAt = new Date().toISOString();
      await saveTask(child);
      return `Resumed ${id} with your instructions${child.approvedUntil && Date.parse(child.approvedUntil) > Date.now() ? " (its approval is still valid)" : ""}. It will report back when done.`;
    }
    case "stop_browser_task": {
      const t = await stopTask(String(input?.taskId || ""), task.owner);
      return t ? `Stopped ${t.id} ("${t.title}").` : `error: no browser task ${input?.taskId}`;
    }
    case "start_browser_task": {
      if (!web.browserConfigured()) return "error: the browser isn't set up yet (Browserbase keys missing) — tell the parent it's not configured.";
      const goal = String(input?.goal || "").trim();
      if (!goal) return "error: goal required";
      // One job, one task: if a related browser task is still in flight, continue it.
      for (const t of await getTaskMetas(await listActiveTaskIds())) {
        if (t.kind !== "browser" || (t.status !== "running" && t.status !== "waiting")) continue;
        if (Date.now() - Date.parse(t.updatedAt) > 3 * 3600 * 1000) continue;
        if (titlesSimilar(t.title, goal)) return `error: browser task ${t.id} ("${t.title}") is already in progress for this — use resume_browser_task with that id instead of starting another.`;
      }
      // Is this job something the parent actually asked for (not an instruction from an email or page)?
      const parentWords = recentParentWords(task);
      const g = await guardCheck({
        action: "start_browser_task",
        parentRequest: parentWords,
        proposal: `Start a web task. GOAL: ${goal}${input?.details ? ` DETAILS: ${String(input.details)}` : ""}`,
      });
      if (!g.ok) return `error: the safety check didn't clear this task (${g.reason}). Ask the parent to confirm exactly what they want done first.`;
      const id = `task-web-${Date.now().toString(36)}`;
      const child = newTask(id, shortTitle(goal, 80), task.owner, task.channel);
      child.kind = "browser";
      child.parentRequest = `${parentWords}\nGOAL: ${goal}${input?.details ? `\nDETAILS: ${String(input.details).trim()}` : ""}`.slice(0, 2000);
      const who = task.owner === "alex" ? "Alex" : "Sam";
      (child.thread as Anthropic.MessageParam[]).push({
        role: "user",
        content: `[${who} · ${task.channel} · ${nowPT()} PT]\nGOAL: ${goal}\n${input?.details ? `DETAILS: ${String(input.details).trim()}\n` : ""}Work this in the browser. When finished (or stuck), reply with the outcome for the family.`,
      });
      pushLog(child, { at: new Date().toISOString(), kind: "user", who, text: `GOAL: ${goal}${input?.details ? ` — ${String(input.details).trim()}` : ""}` });
      child.status = "running";
      child.nextCheckAt = new Date().toISOString();
      await saveTask(child);
      return `Started background browser task ${id}. It will message ${who} when done, or when it needs approval for an irreversible step.`;
    }

    // ── browser ──
    case "browse_goto": {
      const url = String(input?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return "error: url must start with http(s)://";
      const { page } = await ensureBrowser(ctx);
      await web.goto(page, url);
      return await web.readPage(page, 4000);
    }
    case "browse_read": {
      const { page } = await ensureBrowser(ctx);
      return await web.readPage(page, Math.min(Math.max(Number(input?.maxText) || 6000, 500), 15000));
    }
    case "browse_click": {
      const n = Number(input?.n);
      if (!Number.isInteger(n)) return "error: n required";
      const { page } = await ensureBrowser(ctx);
      const label = await web.elementText(page, n);
      const approved = !!task.approvedUntil && Date.parse(task.approvedUntil) > Date.now();
      const committing = COMMIT_RE.test(label) && !SAFE_RE.test(label);
      if (committing && !approved) {
        return `BLOCKED: [${n}] "${label.slice(0, 60)}" looks like an irreversible step. Call request_approval first, describing exactly what will happen; once a parent approves, retry the click.`;
      }
      if (committing) {
        // Second check: is this click what the parent asked for and approved?
        const text = await web.pageText(page);
        const g = await guardCheck({
          action: "commit_click",
          parentRequest: parentRequestOf(task),
          approved: task.approvedFor,
          proposal: `Click "${label.slice(0, 80)}" on ${page.url().slice(0, 150)}`,
          facts: pageFacts(page.url(), await page.title().catch(() => ""), String(text)),
        });
        if (!g.ok) {
          task.approvedUntil = undefined;
          task.guardNote = g.reason;
          return `BLOCKED by the safety check: ${g.reason}. Do not try to work around this. If the parent really wants this exact step, call request_approval describing it precisely (the parent will see the safety note); otherwise stop and report.`;
        }
        await redis.set(`kimi_purchase:${task.id}`, { host: hostOf(page.url()), at: new Date().toISOString(), what: task.approvedFor || label }, { ex: 3 * 86400 }).catch(() => {});
      }
      await web.click(page, n);
      return `Clicked [${n}] "${label.slice(0, 60)}".\n\n${await web.readPage(page, 3500)}`;
    }
    case "browse_type": {
      const n = Number(input?.n);
      if (!Number.isInteger(n)) return "error: n required";
      const { page } = await ensureBrowser(ctx);
      await web.type(page, n, String(input?.text ?? ""), input?.pressEnter === true);
      return `Typed into [${n}].${input?.pressEnter ? `\n\n${await web.readPage(page, 3500)}` : ""}`;
    }
    case "browse_select": {
      const n = Number(input?.n);
      if (!Number.isInteger(n)) return "error: n required";
      const { page } = await ensureBrowser(ctx);
      await web.select(page, n, String(input?.value ?? ""));
      return `Selected "${input?.value}" in [${n}].`;
    }
    case "browse_press": {
      const { page } = await ensureBrowser(ctx);
      await web.press(page, String(input?.key || "Enter"));
      return await web.readPage(page, 3500);
    }
    case "browse_screenshot": {
      const { page } = await ensureBrowser(ctx);
      const data = await web.screenshot(page);
      return [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        { type: "text", text: `Screenshot of ${page.url()}` },
      ];
    }
    case "list_credentials": {
      if (!credentialsAvailable()) return "No login source is set up (neither 1Password nor the local vault). Tell the parent.";
      const list = await listCredentials();
      const broken = list.find((c) => c.name.startsWith("(1Password unavailable"));
      if (broken && list.length === 1) return `error: ${broken.name.slice(1, -1)}. Do NOT retry — stop and report that the login vault is temporarily unavailable.`;
      return list.length
        ? list.map((c) => `• ${c.name} — ${c.site || "(no site)"}${c.username ? ` (user: ${c.username})` : ""}${c.hasOtp ? " · has one-time code" : ""}`).join("\n")
        : "No logins available. Ask the parent to move the login into the 1Password “Family HQ” vault or add it under Assistant → Logins.";
    }
    case "browse_fill_credential": {
      const n = Number(input?.n);
      const field = input?.field === "password" ? "password" : input?.field === "otp" ? "otp" : "username";
      const value = await getCredentialField(String(input?.name || ""), field);
      if (value == null) return `error: no ${field} found for a login named "${input?.name}" — check list_credentials for the exact name`;
      const { page } = await ensureBrowser(ctx);
      if (field === "username") await web.type(page, n, value, false);
      else await web.typeSecret(page, n, value);
      return `Filled ${field} for "${input?.name}" into [${n}].`;
    }
    case "list_cards": {
      if (!opConfigured()) return "No card source is set up (1Password isn't connected). Tell the parent.";
      const cards = await listOpCards();
      if (!cards.length) return "No payment cards in the family's 1Password “Family HQ” vault. Ask the parent to add one, or use a card already saved on the site.";
      return cards.map((c) => `• ${c.title} — ${c.brand || "card"} ending ${c.last4 || "????"}${c.business ? " · COMPANY CARD: never use unless the parent named it" : ""}`).join("\n");
    }
    case "browse_fill_card": {
      const name = String(input?.card || "").trim();
      if (!name) return "error: card required";
      const cards = await listOpCards();
      const want = name.toLowerCase();
      const card = cards.find((c) => c.title.toLowerCase() === want) || cards.find((c) => c.title.toLowerCase().includes(want) || want.includes(c.title.toLowerCase()));
      if (!card) return `error: no card named "${name}" — check list_cards for the exact name`;
      const approved = !!task.approvedUntil && Date.parse(task.approvedUntil) > Date.now();
      const approvedText = (task.approvedFor || "").toLowerCase();
      if (!approved || !(approvedText.includes(card.title.toLowerCase()) || (card.last4 && approvedText.includes(card.last4)))) {
        return `BLOCKED: a parent hasn't approved paying with ${card.title}. Call request_approval with the complete purchase — items, total, and "pay with ${card.title} ending ${card.last4}" — then fill the card once approved.`;
      }
      const request = parentRequestOf(task).toLowerCase();
      if ((card.business || BUSINESS_CARD_RE.test(card.title)) && !request.includes(card.title.toLowerCase())) {
        return `BLOCKED: ${card.title} is a company card and the parent didn't ask to use it. Use a personal card instead (ask again naming it), or stop and ask the parent.`;
      }
      const { page } = await ensureBrowser(ctx);
      const text = await web.pageText(page);
      const g = await guardCheck({
        action: "fill_card",
        parentRequest: parentRequestOf(task),
        approved: task.approvedFor,
        proposal: `Enter the ${card.title} card (ending ${card.last4}) on ${page.url().slice(0, 150)}`,
        facts: pageFacts(page.url(), await page.title().catch(() => ""), String(text)),
      });
      if (!g.ok) {
        task.approvedUntil = undefined;
        task.guardNote = g.reason;
        return `BLOCKED by the safety check: ${g.reason}. Do not work around this; ask for approval again describing exactly this payment, or stop and report.`;
      }
      const secret = await getOpCard(card.title);
      if (!secret) return `error: couldn't read ${card.title} from 1Password (missing number?) — stop and tell the parent.`;
      const home = (await getProfile()).sections.find((x) => x.key === "home")?.body.match(/\b\d{5}\b/)?.[0] || null;
      const filled = await web.fillCard(page, { number: secret.number, expMonth: secret.expMonth, expYear: secret.expYear, cvc: secret.cvc, name: secret.name, zip: secret.zip || home });
      if (!filled.length) return `No card fields found on this page. If the payment form is behind a button (e.g. "Add a card", "Credit or debit card"), click it, then call browse_fill_card again.`;
      return `Entered ${card.title} (ending ${card.last4}): ${filled.join(", ")}.${filled.includes("billing ZIP") && !secret.zip ? " (Billing ZIP: the home ZIP.)" : ""} Check the page with browse_read before placing the order.\n\n${await web.readPage(page, 3000)}`;
    }
    case "request_approval": {
      const description = String(input?.description || "").trim();
      if (!description) return "error: description required";
      if (task.approvedUntil && Date.parse(task.approvedUntil) > Date.now()) {
        return `Already approved for this task (${task.approvedFor || "earlier step"}) — no need to ask again. Proceed and finish.`;
      }
      let shot: string | undefined;
      let url: string | undefined;
      if (input?.includeScreenshot !== false && ctx.handle) {
        shot = await web.screenshot(ctx.handle.page).catch(() => undefined);
        url = ctx.handle.page.url();
      }
      const note = task.guardNote ? `⚠️ Kimi's safety check flagged the last attempt: ${task.guardNote}\n\n` : "";
      task.guardNote = undefined;
      const payload: StepPayload = { taskId: task.id, description: note + description, url, screenshot: shot };
      const a = await proposeAction({
        kind: "confirm_step",
        title: description.slice(0, 90),
        summary: `Browser task "${task.title}" is asking to proceed.`,
        payload,
        taskId: task.id,
        requestedBy: "agent",
        channel: task.channel,
      });
      task.waitingOn = a.id;
      task.approvedFor = description.slice(0, 200);
      task.status = "waiting";
      task.nextCheckAt = undefined;
      await notify(
        task.owner,
        `Needs your approval — ${note}${description}\n\n${task.channel === "sms" ? "Reply APPROVE or DECLINE." : "Open Chat in Family HQ to approve or decline."}`,
        task.channel
      ).catch((e) => console.error("approval notify failed", e));
      return `WAITING_APPROVAL ${a.id}: paused until a parent decides. Stop here. (The browser is closed while you wait — you'll still be signed in when resumed, but navigate back to where you were before continuing.)`;
    }
    default:
      return `error: unknown tool ${name}`;
  }
}

// ── System prompt ────────────────────────────────────────────────────────────

const BROWSER_MODE = `
BROWSER TASK MODE — you are working a background job in a real web browser on the family's behalf.
- Work step by step: browse_goto → browse_read → act → browse_read. Read the page after every action; never assume it worked. Prefer browse_read; use browse_screenshot only when layout matters or text is ambiguous.
- Logins: list_credentials, then browse_fill_credential for BOTH username and password (and field='otp' if the site asks for an authenticator code and the login has one). Never ask for, type, or guess a password.
- Approval: ask ONCE per job, right before the first click that commits money, a booking, a registration, a cancellation, or a message. Get everything in order first (cart, address, shipping, payment method, review page), then call request_approval describing the COMPLETE outcome — item(s), total price, ship-to, payment method, date/time — so the parent can say yes once. Getting to the checkout/review page needs no approval. Once approved, finish the job without asking again (the approval covers the whole job, for hours); if you truly must deviate from what was approved (different total, different item), ask again with the difference.
- Paying: prefer a card already saved on the site. If the site needs a card entered, call list_cards and pick the card the parent named — otherwise a personal card, NEVER a company card unless the parent named it. Name it in request_approval ("pay with Family Visa ending 4242"), and after approval call browse_fill_card. Never type card numbers yourself.
- A separate safety check reviews payment clicks and card entry against what the parent asked for. If it blocks a step, don't look for another way around it — ask again describing exactly that step, or stop and report.
- CAPTCHA, 2FA, a tool returning an error twice, or stuck after 3 attempts at the same thing → stop and report what you found and what's needed. Never retry the same failing call in a loop.
- Stay on task; don't browse beyond what the goal needs. Don't accept unrelated offers or add-ons.
- When done: reply with a concise outcome — what was done, confirmation numbers, anything still pending. Put long details in a File (create_file).`;

export async function systemPrompt(task: Task): Promise<string> {
  const [kids, profile] = await Promise.all([getCollection("kids"), getProfile()]);
  const roster = kids
    .map((k) => `- ${k.firstName} (id "${k.id}", born ${k.dob}): ${k.current.program} @ ${k.current.school}, teacher(s) ${k.current.teachers.join(", ")}${k.current.aftercare ? `; after school: ${k.current.aftercare}` : ""}`)
    .join("\n");
  return `You are Kimi, the family's assistant, working for Alex (dad, ${CONFIG.parents.alex.email}) and Sam (mom, ${CONFIG.parents.sam.email}), and their kids:
${roster}

${profileContext(profile)}

WHO YOU ARE
You're part of the household team: part executive assistant, part the hyper-organized family friend who never forgets a birthday.
- Warm, upbeat, and quick. You genuinely like this family and it shows; light and a little playful, never saccharine, never chatty for its own sake.
- Proactive: you notice the thing behind the thing (two parties at the same time, a form due before a trip) and say so.
- Direct and honest: lead with the answer; say what you checked; when you miss something, own it in a sentence and fix it.
- Use the parents' names. Cheer the kids on in a word or two when it fits ("Big day for Max!"). At most one emoji per message, and none at all when the topic is health, allergies, money, safety, or anything upsetting — there you're calm and precise.
- Emails you draft are written in the PARENT's voice, not yours. You speak as "I" (Kimi); "HQ" is the name of the app, not you.

HOW YOU WORK
- Be brief and concrete. Lead with the answer. One or two sentences is usually right; a short list when there are several items.
- Never answer a calendar, to-do, or directory question from memory — call get_upcoming, search, or directory first. Quote dates and times as they come back (they're Pacific).
- When a parent tells you about a dated plan or asks to add/track something, file it (add_event / add_todo) and confirm in one line what you filed. Don't ask permission for obvious filings; do ask when the date, time, or who-it's-for is genuinely ambiguous.
- Before add_event / add_todo, check get_upcoming or search: if the thing is already there, update it instead (the tools also refuse near-duplicates). When you add prep to-dos, follow the house conventions below exactly.
- Calendar changes: "move X to Tuesday 3pm" → look it up, update_event, confirm in one line. Deleting or bulk-editing several events → list them first and get a yes in chat before acting. If a parent sends a photo or PDF it is filed automatically before you see the thread — don't re-file it.
- Use remember for durable household facts. Use schedule_followup whenever you say you'll check back, remind, or re-check later — then actually do it when woken.
- Email: you can DRAFT emails with draft_email (teachers, aftercare, vendors, other parents) — in the parent's voice, signed with their first name. Drafts are never sent until a parent approves; say so plainly ("drafted — approve it in Activity", or on SMS "reply APPROVE to send"). Look the address up first; never invent one.
- Files: when the output is a comparison, plan, itinerary, research write-up, or anything with real structure, put it in a File (create_file) and share the link instead of dumping it into chat.
- Work calendars: for planning a day or week, suggesting times, checking a kid event against work, or vacation planning, look at get_work_calendar first. It's context only — never add work meetings to the family calendar, and share only what's needed (e.g. "Alex is in meetings until 4"), not meeting details. Entries marked (hold) have no other attendees: blocks a parent placed on their own calendar. They are NOT meetings — never call them meetings or count them as such. Some are real commitments (Dropoff, school duties, a commute, a flight); others are protected time (DNS = do not schedule, email catch-up, focus) that the parent could flex. Read the title for which. A "commute — office day" hold means that parent is at their office that day; "trip travel" means they're flying. The household facts say who normally does what (e.g. who does drop-off, and which days a parent works from an office). Before calling something a coverage gap because both parents are busy, check the household facts for who else covers (a grandparent, a sitter, after-school care). Only flag a gap when none of them works or a parent specifically needs to be there.
- Money: get_spending answers "what did we spend / did that payment go through" from receipts (say it's from receipts, not a bank statement). To pay a person (babysitter, class fund), use prepare_payment — it gives the parent a Venmo link to confirm; you never send money yourself. Purchases on websites go through a browser task and one approval that names the card; never pick a company card unless the parent says so.
- Weather and travel: for outdoor plans, check get_weather and mention rain or heat when it matters. Event listings include "~N min drive, leave by …" for places a real drive from home — use it when timing matters (who can get there, when to leave).
- VERIFY BEFORE ASSERTING. When you're unsure whether something is done or still needed — an RSVP, a sign-up, a payment, a registration — or of a detail like a time or place, check before you answer: search_email on BOTH parents' inboxes (one of them often replied from their phone), read_link on the invitation or sign-up link in the event's notes or the email, and a browser task if it's behind a login. Never tell a parent something is open or unknown without having looked. Say what you found and where.
- Research: use web_search / web_fetch for the outside world (camps, classes, vendors, hours, prices) and search_email for what's in the inboxes (school inbox, or a parent's own Gmail if connected — pick the account by whose mail it would be). Say briefly where facts came from.
- Anything that needs a real browser (register, book, buy, cancel, fill a site's form, check an account) → start_browser_task with a complete, self-contained goal and details. It pauses ONCE for the parents' approval before committing. You cannot make phone calls.
- While a browser task is in progress, anything the parent sends for it — a verification code, an answer, "go ahead", a change — goes to resume_browser_task with that task's id. Never start a second task for the same job. "Stop / cancel / forget it" → stop_browser_task.
- Messages arrive tagged with who sent them ([Alex …] or [Sam …]); address the person who wrote.
- SMS replies: plain text, no markdown, under ~300 characters unless listing items. App replies: light markdown is fine.
- Everything is in Pacific time.

${PREP_CONVENTIONS}

${NAME_COLLISIONS}${task.kind === "browser" ? "\n" + BROWSER_MODE : ""}`;
}

export function toolsFor(task: Task): Anthropic.Messages.ToolUnion[] {
  return task.kind === "browser" ? [...BASE_TOOLS, ...BROWSER_TOOLS] : [...BASE_TOOLS, ...CHAT_ONLY_TOOLS];
}

// ── Thread helpers ───────────────────────────────────────────────────────────

// Trim in chunks, not a sliding window: once the thread passes MAX_THREAD, cut back to
// about KEEP_THREAD. The start then stays put for many turns, so the cached prefix keeps
// matching (a window that slides every message invalidates the whole cache each time).
const MAX_THREAD = 80;
const KEEP_THREAD = 40;
// Tool results from finished turns are cut to this many characters.
const COMPACT_AT = 700;
const COMPACT_KEEP = 400;

function isPlainUser(m: Anthropic.MessageParam): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return m.content.some((b) => b.type === "text") && !m.content.some((b) => b.type === "tool_result");
}

/** Keep the thread bounded; always cut at a plain user message so tool pairs stay intact. */
export function trimThread(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  let out = msgs;
  if (out.length > MAX_THREAD) {
    let start = out.length - KEEP_THREAD;
    while (start < out.length && !isPlainUser(out[start])) start++;
    // A long browser job may have no plain user message in range — never cut it to nothing.
    if (start < out.length) out = out.slice(start);
  }
  return compactFinishedTurns(dropOldImages(out));
}

function lastPlainUserIndex(msgs: Anthropic.MessageParam[], before = msgs.length): number {
  for (let i = before - 1; i >= 0; i--) if (isPlainUser(msgs[i])) return i;
  return -1;
}

/**
 * Once a turn is over, its working material is dead weight that would be re-sent on
 * every later call: the model's reasoning, and full tool output (event lists, calendar
 * dumps, email search results). Everything before the current turn's user message keeps
 * its conversation but loses both. Deterministic and idempotent, so the compacted prefix
 * is byte-identical from call to call and stays cached.
 */
function compactFinishedTurns(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const boundary = lastPlainUserIndex(msgs);
  if (boundary <= 0) return msgs;
  return msgs.map((m, i) => {
    if (i >= boundary || typeof m.content === "string") return m;
    if (m.role === "assistant") {
      const kept = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      if (kept.length === m.content.length) return m;
      return { ...m, content: kept.length ? kept : [{ type: "text" as const, text: "(…)" }] };
    }
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      const text = typeof b.content === "string" ? b.content : (b.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      if (text.length <= COMPACT_AT) return b;
      changed = true;
      return { ...b, content: `${text.slice(0, COMPACT_KEEP)}\n…[trimmed after that turn — call the tool again for the full result]` };
    });
    return changed ? { ...m, content } : m;
  });
}

/**
 * Mark the end of the conversation as a cache breakpoint, so each step of the
 * tool loop re-reads the history from cache instead of paying for it again.
 * Applied to a shallow copy — the stored thread never carries cache markers.
 */
export function withCacheBreakpoint(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (!msgs.length) return msgs;
  const mark = (m: Anthropic.MessageParam): Anthropic.MessageParam => {
    const blocks: Anthropic.ContentBlockParam[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];
    if (!blocks.length) return m;
    const i = blocks.length - 1;
    blocks[i] = { ...blocks[i], cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
    return { ...m, content: blocks };
  };
  const out = [...msgs];
  out[out.length - 1] = mark(out[out.length - 1]);
  // Also mark the previous turn's opening message. The first call of that turn cached
  // everything up to it, and compacting that turn afterwards doesn't touch anything
  // before it — so a new message re-reads the older history from cache.
  const cur = lastPlainUserIndex(out);
  const prev = cur > 0 ? lastPlainUserIndex(out, cur) : -1;
  if (prev >= 0 && prev < out.length - 1) out[prev] = mark(out[prev]);
  return out;
}

/**
 * Screenshots are ~100 KB each and would be re-sent to the model (and re-stored)
 * on every later step. Only the most recent one is still useful; older ones
 * become a one-line placeholder.
 */
function dropOldImages(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  let seenLatest = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      if (!block.content.some((c) => c.type === "image")) continue;
      if (!seenLatest) {
        seenLatest = true;
        continue;
      }
      block.content = block.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[earlier screenshot omitted]" } : c));
    }
  }
  return msgs;
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function pushLog(task: Task, entry: TaskLogEntry) {
  task.log.push(entry);
  if (task.log.length > 200) task.log = task.log.slice(-200);
}

export function newTask(id: string, title: string, owner: "alex" | "sam", channel: Channel): Task {
  const now = new Date().toISOString();
  return { id, title, status: "open", kind: "chat", channel, owner, createdAt: now, updatedAt: now, thread: [], log: [] };
}

/** Append a parent's message to the task thread (tagged with speaker/channel/time). */
export function addUserMessage(task: Task, who: "alex" | "sam", channel: Channel, text: string) {
  const name = who === "alex" ? "Alex" : "Sam";
  (task.thread as Anthropic.MessageParam[]).push({ role: "user", content: `[${name} · ${channel} · ${nowPT()} PT]\n${text}` });
  pushLog(task, { at: new Date().toISOString(), kind: "user", who: name, text });
  task.owner = who;
  task.channel = channel;
  task.status = "running";
}

// ── The loop ─────────────────────────────────────────────────────────────────

/**
 * Run the task until the assistant replies, pauses for approval, or hits the
 * deadline — in which case the thread is checkpointed mid-work with
 * nextCheckAt=now so the next cron tick resumes it. Returns the reply text
 * ("" if still working or waiting).
 */
export async function runAgent(task: Task, opts: { deadlineMs: number; maxSteps?: number }): Promise<string> {
  const maxSteps = opts.maxSteps ?? (task.kind === "browser" ? 40 : 20);
  const system = await systemPrompt(task);
  const tools = toolsFor(task);
  const messages = trimThread(task.thread as Anthropic.MessageParam[]);
  task.thread = messages;
  const ctx: RunCtx = { task, handle: null };
  let steps = 0;
  let reply = "";

  try {
    while (steps++ < maxSteps) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools,
        output_config: { effort: "medium" },
        messages: withCacheBreakpoint(messages),
      });

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "refusal") {
        reply = "I can't help with that one.";
        break;
      }
      if (response.stop_reason === "pause_turn") {
        if (Date.now() > opts.deadlineMs) break;
        continue; // server-side tool loop wants to keep going
      }

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!toolUses.length || response.stop_reason === "max_tokens") {
        reply = textOf(response.content);
        break;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      let waiting = false;
      for (const tu of toolUses) {
        let out: ToolOut;
        let isError = false;
        try {
          out = await runTool(tu.name, tu.input, ctx);
          isError = typeof out === "string" && out.startsWith("error:");
        } catch (e) {
          out = `error: ${String(e).slice(0, 300)}`;
          isError = true;
        }
        if (typeof out === "string" && out.startsWith("WAITING_APPROVAL")) waiting = true;
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out, is_error: isError || undefined });
        const line = typeof out === "string" ? out.split("\n")[0].slice(0, 160) : "(screenshot)";
        pushLog(task, { at: new Date().toISOString(), kind: "tool", text: `${tu.name}: ${line}` });
      }
      messages.push({ role: "user", content: results });
      await saveTask(task); // checkpoint after every step

      if (waiting) {
        // Waiting on a parent can take hours; an idle hosted browser bills the
        // whole time. Close it — the persistent profile keeps the site logins.
        await ctx.handle?.browser.close().catch(() => {});
        await web.releaseSession(task.browserSessionId).catch(() => {});
        ctx.handle = null;
        task.browserSessionId = undefined;
        await saveTask(task);
        return ""; // paused for a parent's decision (status already "waiting")
      }

      if (Date.now() > opts.deadlineMs) {
        // Out of time: leave it resumable. Thread ends with tool results, so the
        // next run continues exactly where this one stopped.
        task.status = "running";
        task.nextCheckAt = new Date().toISOString();
        await saveTask(task);
        return "";
      }
    }
  } finally {
    // Drop our CDP connection; a hosted session stays alive (keepAlive) for resumes.
    await ctx.handle?.browser.close().catch(() => {});
  }

  if (!reply) reply = textOf((messages[messages.length - 1]?.content as Anthropic.ContentBlock[]) || []) || "(no reply)";
  task.lastReply = reply;
  // A pending follow-up (nextCheckAt in the future) keeps the task "waiting".
  task.status = task.status === "waiting" || (task.nextCheckAt && task.nextCheckAt > new Date().toISOString()) ? "waiting" : "open";
  pushLog(task, { at: new Date().toISOString(), kind: "assistant", text: reply });
  await saveTask(task);
  return reply;
}

/** Handle one inbound message on a task under its lock; returns the reply ("" if deferred). */
export async function converse(taskId: string, who: "alex" | "sam", channel: Channel, text: string, deadlineMs: number): Promise<{ reply: string; task: Task }> {
  const got = await acquireTaskLock(taskId, 240);
  if (!got) throw new Error("busy");
  try {
    const task = (await getTask(taskId)) || newTask(taskId, "Family chat", who, channel);
    addUserMessage(task, who, channel, text);
    await saveTask(task);
    const reply = await runAgent(task, { deadlineMs });
    return { reply, task };
  } finally {
    await releaseTaskLock(taskId);
  }
}

/**
 * Record a user message and a ready-made reply on a task without running the
 * model — used when something else (the file-this pipeline) already did the work.
 */
export async function appendExchange(taskId: string, who: "alex" | "sam", channel: Channel, userText: string, assistantText: string): Promise<Task> {
  if (!(await acquireTaskLock(taskId, 60))) throw new Error("busy");
  try {
    const task = (await getTask(taskId)) || newTask(taskId, "Family chat", who, channel);
    const prior = task.status;
    addUserMessage(task, who, channel, userText);
    (task.thread as Anthropic.MessageParam[]).push({ role: "assistant", content: assistantText });
    pushLog(task, { at: new Date().toISOString(), kind: "assistant", text: assistantText });
    task.lastReply = assistantText;
    task.status = prior === "waiting" ? "waiting" : "open";
    await saveTask(task);
    return task;
  } finally {
    await releaseTaskLock(taskId);
  }
}

const MAX_TASK_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_TOOL_CALLS = 160;
function tooLong(task: Task): boolean {
  return Date.now() - Date.parse(task.createdAt) > MAX_TASK_AGE_MS || task.log.filter((e) => e.kind === "tool").length > MAX_TOOL_CALLS;
}

/**
 * The escape hatch: stop a background task now. Releases its browser, declines
 * any approval it was waiting on, tells the owner, and notes it in the family chat.
 */
export async function stopTask(taskId: string, by: string, reason = "stopped by a parent"): Promise<Task | null> {
  const task = await getTask(taskId);
  if (!task || task.kind !== "browser") return null;
  if (task.status === "done" || task.status === "cancelled" || task.status === "failed") return task;
  await releaseTaskLock(taskId); // whoever held it is being cut off
  await web.releaseSession(task.browserSessionId).catch(() => {});
  task.browserSessionId = undefined;
  task.status = by === "system" ? "failed" : "cancelled";
  task.nextCheckAt = undefined;
  task.waitingOn = undefined;
  task.lastReply = `Stopped — ${reason}.`;
  pushLog(task, { at: new Date().toISOString(), kind: "system", text: `Stopped by ${by}: ${reason}` });
  await saveTask(task);
  // Any approval card it left behind is moot.
  try {
    const { getCollection, setCollection } = await import("./db.js");
    const actions = await getCollection("actions");
    let changed = false;
    for (const a of actions) {
      if (a.taskId === taskId && a.status === "proposed") {
        a.status = "declined";
        a.decidedAt = new Date().toISOString();
        a.decidedBy = by;
        a.result = "task stopped";
        changed = true;
      }
    }
    if (changed) await setCollection("actions", actions);
  } catch (e) {
    console.error("stopTask: action cleanup failed", e);
  }
  const msg = `Background task "${task.title}" was stopped (${reason}).`;
  if (by === "system") await notify(task.owner, msg, task.channel).catch(() => {});
  await postToMain(msg).catch(() => {});
  return task;
}

/** Let the family chat know a background task finished (best-effort, non-blocking). */
async function postToMain(text: string): Promise<void> {
  if (!(await acquireTaskLock(MAIN_TASK_ID, 30))) return;
  try {
    const main = (await getTask(MAIN_TASK_ID)) || newTask(MAIN_TASK_ID, "Family chat", "alex", "app");
    (main.thread as Anthropic.MessageParam[]).push({ role: "user", content: `[system · background task · ${nowPT()} PT]\n${text}` });
    pushLog(main, { at: new Date().toISOString(), kind: "assistant", text });
    if (main.status === "running") main.status = "open";
    await saveTask(main);
  } finally {
    await releaseTaskLock(MAIN_TASK_ID);
  }
}

/**
 * Cron entry point: resume any task that's mid-work or whose scheduled
 * follow-up is due, and deliver the resulting reply on the task's channel.
 */
export async function runDueTasks(budgetMs: number): Promise<number> {
  const started = Date.now();
  const metas = await getTaskMetas(await listActiveTaskIds());
  let ran = 0;
  for (const meta of metas) {
    const id = meta.id;
    if (Date.now() - started > budgetMs) break;
    if (meta.status === "done" || meta.status === "failed" || meta.status === "cancelled") continue;
    const nowIso = new Date().toISOString();
    // Due: a scheduled check-in has arrived. Stranded: the function was killed
    // mid-run (time limit, crash), leaving "running" with no next check — pick it
    // up again once it's been quiet for a few minutes.
    const due = !!meta.nextCheckAt && meta.nextCheckAt <= nowIso;
    const stranded = meta.status === "running" && !meta.nextCheckAt && Date.now() - Date.parse(meta.updatedAt) > 3 * 60 * 1000;
    if (!due && !stranded) continue;
    // Give up on background jobs that keep going nowhere.
    if (meta.kind === "browser" && tooLong(meta as Task)) {
      await stopTask(id, "system", `gave up: it had been running for ${Math.round((Date.now() - Date.parse(meta.createdAt)) / 60000)} minutes over ${meta.log.filter((e) => e.kind === "tool").length} steps without finishing`);
      continue;
    }
    if (!(await acquireTaskLock(id, 240))) continue;
    const task = await getTask(id);
    if (!task) {
      await releaseTaskLock(id);
      continue;
    }
    try {
      if (stranded) pushLog(task, { at: nowIso, kind: "system", text: "Resumed after an interrupted run." });
      if (task.followupNote) {
        const note = task.followupNote;
        (task.thread as Anthropic.MessageParam[]).push({
          role: "user",
          content: `[system · check-in · ${nowPT()} PT]\nScheduled follow-up: ${note}\nDo what you promised (look things up if needed) and write the message the family should receive now.`,
        });
        pushLog(task, { at: new Date().toISOString(), kind: "system", text: `Check-in: ${note}` });
      }
      task.nextCheckAt = undefined;
      task.followupNote = undefined;
      task.status = "running";
      await saveTask(task);
      const reply = await runAgent(task, { deadlineMs: started + budgetMs });
      if (reply) {
        await notify(task.owner, reply, task.channel).catch((e) => console.error("notify failed", e));
        if (task.kind === "browser") {
          await web.releaseSession(task.browserSessionId);
          task.browserSessionId = undefined;
          task.status = "done";
          await saveTask(task);
          await postToMain(`Background task "${task.title}" finished:\n${reply}`).catch(() => {});
        }
      }
      ran++;
    } finally {
      await releaseTaskLock(id);
    }
  }
  return ran;
}
