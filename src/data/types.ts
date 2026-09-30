// ─────────────────────────────────────────────────────────────────────────────
// Core domain types for the family family-hq hub.
// All persisted data conforms to these shapes. The data files (kids.ts, meta.ts,
// comms.ts, events.ts, todos.ts) are the source of truth maintained by the
// ingestion workflow (you forward/paste an item → it gets classified & filed).
// ─────────────────────────────────────────────────────────────────────────────

export type KidId = "max" | "theo" | "ava";

/** Where a communication originated. */
export type Source =
  | "parentsquare"
  | "aeries"
  | "band"
  | "brightwheel"
  | "email"
  | "text"
  | "calendar"
  | "other";

/**
 * The classification that drives whether something surfaces to the parents.
 * - fyi:      logged only (e.g. "kids did Hamma beads Monday"). Never surfaces.
 * - calendar: a dated event (→ Google Calendar). Surfaces in Calendar/Today.
 * - action:   requires the parents to do something (e.g. "send a white shirt Friday").
 * - alert:    time-sensitive AND action-required. Surfaces loudly on Today.
 */
export type Category = "fyi" | "calendar" | "action" | "alert";

export interface Kid {
  id: KidId;
  firstName: string;
  fullName: string;
  dob: string; // ISO date
  color: string; // tailwind-ish hex for UI accents
  current: {
    school: string;
    program: string; // e.g. "Kindergarten", "Preschool", "Daycare"
    teachers: string[];
    aftercare?: string;
  };
  fall: {
    program: string;
    teachers: string[]; // may contain "TBD"
    school: string;
    aftercare?: string;
  };
  /** Channels that carry comms for this kid. */
  channels: Source[];
}

export interface Contact {
  id: string;
  name: string;
  role: string; // "Kindergarten teacher", "Aftercare lead", "Daycare", ...
  kidIds: KidId[];
  org?: string;
  email?: string;
  phone?: string;
  /** Venmo username, for one-tap payments the parent completes in Venmo. */
  venmo?: string;
  notes?: string;
}

export interface Place {
  id: string;
  name: string;
  kind: "school" | "daycare" | "aftercare";
  address?: string;
  phone?: string;
  website?: string;
  notes?: string;
}

export interface Routine {
  id: string;
  kidId: KidId;
  label: string; // "Drop-off", "Pick-up"
  detail: string; // who/when/where; free text, parents fill in
}

/** A single ingested communication. */
export interface Comm {
  id: string;
  receivedAt: string; // ISO datetime the parent received it
  source: Source;
  people?: string[]; // who it's FOR / about (family ids or guest names)
  owner?: string[]; // who's RESPONSIBLE (usually alex/sam)
  kidIds?: KidId[]; // legacy; read via peopleOf()
  category: Category;
  subject: string;
  /** One-line plain-English summary of what it is. */
  summary: string;
  /** Why it was classified this way (transparency for the smart filter). */
  reason?: string;
  /** The original text, kept for reference (fetched on demand by the app). */
  raw?: string;
  /** Set by /api/data when `raw` exists but was left out of the payload. */
  hasRaw?: boolean;
  /** Which mailbox it came from: the forwarding inbox, or a parent's own Gmail (watched). */
  mailbox?: "school" | "alex" | "sam";
  /** IDs of events / todos spun out of this comm. */
  eventIds?: string[];
  todoIds?: string[];
}

export interface CalEvent {
  id: string;
  title: string;
  date: string; // ISO date (YYYY-MM-DD) — start/departure date
  start?: string; // optional HH:mm (local to startTz)
  end?: string; // optional HH:mm (local to endTz)
  /** Arrival/end date if it differs from `date` (e.g. a red-eye landing next day). Defaults to `date`. */
  endDate?: string; // YYYY-MM-DD
  /** IANA timezone of the start time (e.g. "America/Los_Angeles"). For flights, the departure airport's zone. */
  startTz?: string;
  /** IANA timezone of the end time (e.g. "America/New_York"). For flights, the arrival airport's zone. */
  endTz?: string;
  allDay: boolean;
  people?: string[];
  owner?: string[];
  kidIds?: KidId[]; // legacy; read via peopleOf()
  location?: string;
  /** What to bring / prep, if any. */
  prep?: string;
  source?: Source;
  commId?: string;
  /** Google Calendar event id once synced. */
  gcalId?: string;
  /** Estimated drive from home in minutes (set by the travel stage for events with a location). */
  travelMin?: number;
  /** The location string travelMin was computed for — recomputed when the location changes. */
  travelFor?: string;
  /** Private to one parent (made in their "Just me" chat); absent = shared with the family. */
  privateTo?: "alex" | "sam";
}

/**
 * How a scheduled task repeats. Dates are evaluated in the home time zone.
 * weekly: `weekdays` (0 = Sunday … 6 = Saturday; default: the first run's weekday).
 * monthly: `monthDay` (1–31, clamped to short months; -1 = the last day) OR `nth` (e.g. {n: 1, weekday: 2} = first Tuesday; n = -1 for the last).
 * yearly: the first run's month and day.
 */
export interface Repeat {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number; // every N days/weeks/months/years (default 1)
  weekdays?: number[];
  monthDay?: number;
  nth?: { n: number; weekday: number };
  until?: string; // YYYY-MM-DD, inclusive
}

/** Something Kimi does at a set time — once, or on a repeat. */
export interface Schedule {
  id: string;
  title: string; // short label, e.g. "Monthly spending recap"
  instruction: string; // what Kimi should do when it fires
  owner: "alex" | "sam"; // who asked — they get the result
  notify: "owner" | "both";
  channel: Channel; // where the asker was when they set it up
  /** The chat thread it runs in and reports to (default: the family chat). */
  thread?: string;
  time: string; // HH:mm, home time
  anchor: string; // YYYY-MM-DD of the first run (repeat intervals count from here)
  repeat?: Repeat; // absent = one-time
  nextRunAt?: string; // ISO; absent when finished
  active: boolean;
  createdAt: string;
  lastRunAt?: string;
  runs?: number;
  /** Private to one parent (made in their "Just me" chat); absent = shared with the family. */
  privateTo?: "alex" | "sam";
}

/** One purchase, from a receipt in a parent's inbox (or a checkout Kimi completed). */
export interface Purchase {
  id: string;
  date: string; // YYYY-MM-DD
  merchant: string;
  amount: number; // in `currency`
  currency: string; // "USD"
  description: string; // what was bought, short
  orderNumber?: string;
  cardLast4?: string;
  account: "alex" | "sam"; // whose inbox the receipt came from
  /** True when Kimi placed the order (matched to an approved browser checkout). */
  byKimi?: boolean;
  source: "email";
  /** The receipt message it came from (account:uidValidity:uid), for de-duplication. */
  sourceKey?: string;
  createdAt: string;
  /** Private to one parent (made in their "Just me" chat); absent = shared with the family. */
  privateTo?: "alex" | "sam";
}

// A structured change to family metadata (kid info, directory, routines).
export type MetadataOp =
  | { kind: "set_teacher"; kidId: string; term: "current" | "fall"; teachers: string[] }
  | { kind: "set_contact"; name: string; role?: string; kidIds?: string[]; email?: string; phone?: string }
  | { kind: "set_routine"; kidId: string; label: string; detail: string }
  | { kind: "set_school"; kidId: string; term: "current" | "fall"; school: string }
  | { kind: "promote_kid"; kidId: string } // new school year: fall → current
  // Calendar deletion (preview→confirm). eventIds = Google Calendar ids;
  // storeIds = matching app-store event ids to remove alongside (reconcile flow).
  | { kind: "delete_events"; eventIds: string[]; storeIds?: string[] }
  | {
      kind: "edit_events";
      eventIds: string[];
      set: { date?: string; start?: string; end?: string; location?: string; title?: string };
    };

// A proposed metadata change awaiting the user's one-tap approval.
export interface Suggestion {
  id: string;
  description: string; // human-readable, e.g. "Set Max's fall teacher to Ms. X"
  op: MetadataOp;
  createdAt: string;
  commId?: string;
  notBefore?: string; // optional date gate (e.g. only show on/after first day)
}

// Standing household facts an EA would know — drives proactive to-do inference.
export interface ProfilePerson {
  id: string;
  name: string;
  phone?: string;
  relation: string; // "Friend family" | "Relative (helps with childcare)" | "Service" | ...
  note?: string; // partner, kids, role, etc.
  /** Venmo username, for one-tap payments the parent completes in Venmo. */
  venmo?: string;
}
export interface HouseholdProfile {
  sections: { key: string; title: string; body: string }[]; // free-text facts (allergies, vendors, work, home…)
  people: ProfilePerson[]; // friends, relatives, service providers
}

export interface Todo {
  id: string;
  title: string;
  detail?: string;
  due?: string; // ISO date
  people?: string[];
  owner?: string[];
  kidIds?: KidId[]; // legacy; read via peopleOf()
  priority: "normal" | "high";
  done: boolean;
  source?: Source;
  commId?: string;
  /** Private to one parent (made in their "Just me" chat); absent = shared with the family. */
  privateTo?: "alex" | "sam";
}

// ── Agent tasks ──────────────────────────────────────────────────────────────
// A task is a persistent conversation thread the assistant works on: the shared
// family chat ("task-main") plus any long-running jobs it spawns. The raw model
// thread is opaque to the client; `log` is the human-readable transcript.
export type TaskStatus = "open" | "running" | "waiting" | "blocked" | "done" | "failed" | "cancelled";
/** Where a message came from / where replies go: the app, a one-on-one text, or the family group text. */
export type Channel = "app" | "sms" | "group";

export interface TaskLogEntry {
  at: string; // ISO
  kind: "user" | "assistant" | "tool" | "system";
  who?: string; // speaker name for user entries
  text: string;
}

// ── Actions: anything that touches the outside world (approve-by-default) ────
// The agent PROPOSES; a parent approves (app or SMS "APPROVE"); only then does
// it execute. Every decision and execution lands in the audit log.
export type ActionKind = "send_email" | "confirm_step";
export type ActionStatus = "proposed" | "executed" | "declined" | "failed";
export interface EmailPayload {
  to: string[];
  cc?: string[];
  subject: string;
  body: string; // plain text
}
// A browser task asking permission for an irreversible step (pay, book, register, cancel…).
export interface StepPayload {
  taskId: string;
  description: string; // exactly what will happen: item, amount, date, recipient
  url?: string;
  screenshot?: string; // base64 JPEG of the page at the moment of asking
  hasScreenshot?: boolean; // set by /api/data, which leaves the image out (GET /api/action?id=…&shot=1)
}
export interface Action {
  id: string;
  kind: ActionKind;
  status: ActionStatus;
  title: string; // one line, e.g. 'Email Ms. Rivera re: field trip form'
  summary: string; // why / what it accomplishes
  payload: EmailPayload | StepPayload;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  executedAt?: string;
  result?: string;
  error?: string;
  taskId?: string;
  requestedBy: "alex" | "sam" | "agent";
  channel: Channel;
  /** Private to one parent (made in their "Just me" chat); absent = shared with the family. */
  privateTo?: "alex" | "sam";
}

export interface AuditEntry {
  id: string;
  at: string;
  kind: string; // proposed | approved | declined | executed | failed | file_created | file_shared
  summary: string;
  by?: string;
  ref?: string; // action/file id
  /** Private to one parent (made in their "Just me" chat); absent = shared with the family. */
  privateTo?: "alex" | "sam";
}

// A rendered page the assistant produced (a comparison, a plan, an itinerary).
// Private (login required) unless `public` — then the share token in the URL grants access.
export interface FileDoc {
  id: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
  public: boolean;
  shareToken?: string;
  taskId?: string;
  /** Private to one parent (made in their "Just me" chat); absent = shared with the family. */
  privateTo?: "alex" | "sam";
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  kind?: "chat" | "browser"; // browser = background task driving a real browser
  browserSessionId?: string; // hosted browser session to reconnect to across cron ticks
  waitingOn?: string; // action id when paused for a parent's approval
  approvedUntil?: string; // ISO — window during which irreversible clicks are allowed
  approvedFor?: string; // what the parent approved (the request_approval description)
  /** The parent's own words that started this job (for the safety check). */
  parentRequest?: string;
  /** Why the safety check last blocked a step — shown to the parent with the next approval request. */
  guardNote?: string;
  /** Private to one parent (made in their "Just me" chat); absent = shared with the family. */
  privateTo?: "alex" | "sam";
  /** For a background task: the chat thread that started it (results are posted back there). */
  parentThread?: string;
  channel: Channel; // where the last message came from (and where replies go)
  owner: "alex" | "sam"; // who to notify with proactive replies
  createdAt: string;
  updatedAt: string;
  thread: unknown[]; // Anthropic.MessageParam[] — server-side only
  log: TaskLogEntry[];
  nextCheckAt?: string; // ISO — when the cron should resume/check in
  followupNote?: string; // what the assistant promised to do at nextCheckAt
  lastReply?: string;
}
