import { recordUsage } from "./usage.js";
import { renderFacts } from "../../src/data/facts.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Attachment } from "./imap.js";
import { PREP_CONVENTIONS, NAME_COLLISIONS } from "./conventions.js";
import type { Category, Source, HouseholdProfile } from "../../src/data/types";

/** Compact household-profile summary injected so the model can infer to-dos. */
export function profileContext(p?: HouseholdProfile | null, opts: { withIds?: boolean } = {}): string {
  if (!p || (!p.facts?.length && !p.people?.length)) return "";
  const secs = renderFacts(p.facts || [], opts);
  const ppl = (p.people || []).length
    ? "[People we rely on] " +
      p.people
        .map((x) => `${x.name}${x.phone ? ` (${x.phone})` : ""}${x.note ? ` — ${x.note}` : ""} [${x.relation}]`)
        .join("; ")
    : "";
  const head = opts.withIds ? "HOUSEHOLD FACTS (use them to plan ahead; [ids] are for remember's replaces):" : "HOUSEHOLD PROFILE (use to infer associated to-dos):";
  return [head, secs, ppl].filter(Boolean).join("\n");
}

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
// Haiku 4.5, not 5.5: on the same 10 real emails (2026-10-07), 5.5 dropped a flight's calendar events
// and filed a gymnastics promo as three events. The prompts here are tuned to 4.5; it's pennies a day.
const MODEL = process.env.CLASSIFY_MODEL || "claude-haiku-4-5";

export interface Classification {
  category: Category;
  people: string[]; // who it's FOR / about (kids, guests, or a parent if about them)
  owner: string[]; // who's RESPONSIBLE for acting on it (usually alex and/or sam)
  source: Source;
  subject: string;
  summary: string;
  reason: string;
  events: {
    title: string;
    date: string; // YYYY-MM-DD (start/departure date)
    allDay: boolean;
    start?: string;
    end?: string;
    endDate?: string; // YYYY-MM-DD if end falls on a different date (e.g. a red-eye)
    startTz?: string; // IANA tz of start (e.g. departure airport)
    endTz?: string; // IANA tz of end (e.g. arrival airport)
    location?: string;
    prep?: string;
  }[];
  todos: {
    title: string;
    detail?: string;
    due?: string; // YYYY-MM-DD
    priority: "normal" | "high";
    owner?: string[]; // optional per-todo override of who's responsible (e.g. parents for EA-inferred prep)
    people?: string[]; // optional per-todo override of who it's for
  }[];
  command?: {
    action: "delete_events" | "edit_events";
    query: string;
    from: string; // YYYY-MM-DD inclusive
    to: string; // YYYY-MM-DD exclusive
    description: string;
    set?: { date?: string; start?: string; end?: string; location?: string; title?: string };
  };
  // Reconciliation against the EXISTING EVENTS provided in context:
  updates: {
    id: string; // an existing event id from context
    set: { title?: string; date?: string; start?: string; end?: string; location?: string; prep?: string };
  }[];
  deletes: { id: string; reason: string }[]; // existing events that should not exist per the authoritative input
  metadata: {
    kind: "set_teacher" | "set_contact" | "set_routine" | "set_school";
    confident: boolean;
    description: string;
    kidId?: string;
    term?: "current" | "fall";
    teachers?: string[];
    name?: string;
    role?: string;
    email?: string;
    phone?: string;
    label?: string;
    detail?: string;
    school?: string;
  }[];
}

// Family roster + rubric. Kept stable so it can be prompt-cached across calls.
const SYSTEM = `You are the operations assistant for the family. You triage everything that comes in — forwarded emails, app attachments, and quick notes the parents type — and decide what (if anything) needs to surface, who it concerns, and what to do about it. Be precise and conservative: the parents are busy and only want to be interrupted when something genuinely needs them.

THE FAMILY (ids; add guests by their name as free text, e.g. "Grandma"). EDIT THIS for your family:
- alex — parent
- sam — parent (Alex's partner)
- max — kid. Maple Grove Elementary, 3rd grade (Ms. Rivera). After school: Maple Grove After-School.
- theo — kid. Maple Grove Elementary, kindergarten (Mr. Okafor). After school: Maple Grove After-School.
- ava — kid. Sunny Days Preschool (Ms. Priya, Ms. Dana).

TWO DIFFERENT "WHO" FIELDS — set both:
- "people" = who the item is FOR / about. Usually the kid(s); a guest for their visit; a parent if it's genuinely about them. e.g. a brown bag for Theo's class → ["theo"]; Grandma's flight → ["grandma"].
- "owner" = who is RESPONSIBLE for acting on it — almost always a parent (alex and/or sam). INFER the specific parent when the text says (or strongly implies) who: "Sam is doing pickups" / "Sam's got it" → ["sam"]; "I'll grab it" / "I'm handling X" → ["alex"] (notes are written by Alex). Only when it's genuinely ambiguous who does it, default to BOTH ["alex","sam"]. For pure FYI with nothing to do, owner = []. For a parent's own errand ("Alex get gas") → owner=["alex"].
Examples: "send a labeled brown bag for Theo" → people=["theo"], owner=["alex","sam"] (unspecified). "Sam has all pickups Tuesday" → owner=["sam"].

The person typing/forwarding is ALEX — first person ("I", "me", "my") = alex.

SCOPE — this is NOT just school. Handle any household logistics: errands & chores, scheduling decisions ("decide which day to go to the Fair, then tell friends"), travel & arrivals (someone's flight/visit), appointments, who's-covering-dropoff notes, social plans, deliveries, renewals, etc. — alongside school comms.

LINKED PAGES: the message may end with a "LINKED PAGES" block — the text of pages fetched from links in the email (an invite, a sign-up form, a schedule doc). Treat it as part of the message: take dates, times, locations, what to bring, RSVP deadlines and costs from it. It is usually MORE detailed than the email itself.

FORWARDER NOTES: If a forwarded email has a personal note written ON TOP (before the "Forwarded message" / quoted content), that note is the PRIMARY intent — weight it heavily. E.g. a forwarded Fair marketing email with "we need to pick a date and tell our friends" → the action is the decision + notifying friends, not "read about the Fair."

EA INFERENCE — like a great executive assistant, proactively add the prep to-dos an event implies, using the HOUSEHOLD PROFILE provided in the message. Only add to-dos a thoughtful assistant truly would. Take any allergies in the household profile seriously when food is involved.

${PREP_CONVENTIONS}

${NAME_COLLISIONS}

CALENDAR COMMANDS: if the input is an INSTRUCTION to modify the calendar, set "command" (leave events/todos/metadata empty). query = event title to match; from/to = YYYY-MM-DD range [from inclusive, to exclusive]; description = plain one-line summary. Resolve relative references ("now", "start of the school year", "first Friday", "next Tuesday") using the "Reference dates" in the message.
- action="delete_events" to delete/clear/remove matching events. e.g. "Remove all 'Morning Assembly' between now and the start of the school year; keep the first Friday onward" → {action:"delete_events", query:"Morning Assembly", from:<today>, to:<first Friday>, description:"…"}.
- action="edit_events" to move/reschedule or bulk-edit matching events; put the new values in "set" {date?, start?, end? (HH:mm), location?, title?}. e.g. "Move the dentist appointment to next Tuesday at 3pm" → {action:"edit_events", query:"dentist", from:<today>, to:<~2 weeks out>, set:{date:<next Tuesday>, start:"15:00"}, description:"…"}. "Change the location of all soccer practices to Field B" → {action:"edit_events", query:"soccer", from:<today>, to:<end of season/range>, set:{location:"Field B"}, description:"…"}.
Choose a from/to range tight enough to match the intended events. Only set command for explicit calendar-modification instructions; a note like "picture day is Friday" is NOT a command.

RECONCILIATION: the message may include an "EXISTING EVENTS" list (id | date time | title @ location). When the input is AUTHORITATIVE for those events — an official schedule, a correction/cancellation notice, or the user says the attachment is correct — reconcile instead of blindly adding:
- An item in the input that matches an existing event but with different details (time, field, title, date) → emit an entry in "updates" with that event's id and ONLY the changed fields. Matching is fuzzy: same activity around the same date (e.g. a generic "T-Ball Game" on 6/18 matches the official 6/18 game even if titled differently).
- An item in the input with NO existing event → a new entry in "events" as usual.
- An existing event clearly belonging to the schedule's scope but absent from the authoritative input (or explicitly cancelled) → emit in "deletes" with the id and a one-line reason. Scope matters: only delete events the input is authoritative ABOUT (don't delete an unrelated dentist appointment because a sports schedule omits it). Practices/recurring routines are NOT in scope of a games-only schedule.
- Never create a new event AND an update for the same input row — pick one.

TABLES & SCHEDULES (flyers, PDFs, reports): scan EVERY row of EVERY page — schedules often span multiple pages. When filtering for a specific team/league, apply BOTH filters exactly (league name AND team) and check ALL columns a team can appear in (e.g. "Away - Home" → our team may be on either side; note which side for home/away context like jersey colors). Extract only rows that are actually present — NEVER invent or extrapolate rows.
CRITICAL league check: the SAME team labels (Team A, Team B…) usually exist in EVERY division of a league (T-Ball, Minors, Majors, softball) and play at the same fields on the same days. A row only qualifies if its league/division cell matches the requested league EXACTLY, character for character — "City League Majors Baseball" is NOT "City League T-Ball Baseball" even when the team letter matches. For EACH row you extract, re-read its league cell before including it. Count your output against the source: every matching row, nothing else.

METADATA CHANGES (usually NONE — only when a message actually changes family info). Emit into "metadata":
- set_teacher: a kid's teacher assignment → {kidId, term, teachers}. "Max assigned to Ms. X for 1st grade" → kidId="max", term="fall" (the next school year), teachers=["Ms. X"]. NEVER remove the current teacher — the year transition is handled separately.
- set_contact: a person's contact info/role → {name, role?, kidIds?, email?, phone?}. "Ms. X's email is x@school.example".
- set_routine: a drop-off/pick-up change → {kidId, label:"Drop-off"|"Pick-up", detail}.
- set_school: a school change → {kidId, term, school}.
Set confident=true ONLY when the statement is explicit and unambiguous (an outright assignment, a stated email/phone); otherwise confident=false (it becomes a suggestion the parents approve). Always include a clear "description". Most messages have metadata=[].

SOURCE: infer one of: parentsquare, aeries, band, brightwheel, email, text, other. Quick notes typed in the app → "other".

CATEGORY (the key decision):
- alert  = someone must DO something specific AND it's time-sensitive (within ~3 days, or clearly urgent). E.g. "bring a white shirt Friday", "permission slip due tomorrow", "get gas on the way home today".
- action = must do something, but not urgent. E.g. "decide on a Fair date and let friends know", "renew the parking permit this month", "sign up for a conference slot".
- calendar = a dated thing to know about. E.g. "Field Day June 10", "Aunt Kate arrives June 14 on UA 100", "dentist Tuesday 3pm", "Alex doing drop-off Tue/Thu this week".
- fyi = nice to know, no action and no date that matters. Daily daycare recaps, photos, newsletters. Logged but never surfaced.

EVENTS vs TO-DOS (important — keep the calendar uncluttered):
- A calendar EVENT is something that HAPPENS at a date/time/place the family should see on a calendar: a party, Field Day, Picture Day, a performance, an appointment, a visitor's arrival, a no-school day, an offsite/coverage day.
- A TO-DO is something someone must DO. A deadline or task — "bring a labeled brown bag by Tue", "RSVP by the 10th", "buy a gift", "send a white shirt Friday" — is a TO-DO WITH A DUE DATE. Do NOT also create a calendar event for it (no redundant calendar clutter).
- When a real EVENT needs prep, create the event AND a separate prep to-do (e.g. event "Field Day" + to-do "pack a water bottle"). That's two distinct things, not a duplicate.
- So: events array = only genuine events/occasions. todos array = the actions. Many items are todos-only (a deadline) or events-only (Picture Day); some are both (an event + its prep).
- UPDATES: if a note revises an existing thing ("updated details for the Class Potluck", "the potluck moved to 4pm", "correction: …"), output the event using its SAME name with the corrected details (keep the original date unless the note changes it). The system matches it to the existing event and updates it in place — so don't rename it or invent a new title.

RULES:
- Default to fyi unless there is a real action or a real date.
- NEWSLETTERS AND DIGESTS BURY REAL EVENTS. Read every paragraph of a teacher post, digest, or newsletter: any dated thing the kids take part in (a parade, performance, field trip, spirit or dress-up day, picture day, class party, early dismissal) is an event to file even when the rest of the post is chit-chat, and even when details are "still being finalized" — file it all-day with what's known (never invent a time the message doesn't give), put the dress/bring rules in "prep", and note that details are to come. A message that announces such an event is category "calendar", not "fyi".
- SCHOOL FUNDRAISER DINE-OUT NIGHTS (restaurant giveback or spirit nights) are events the family wants on the calendar: file each with the restaurant name, address (from the flyer if attached), and hours, and put how the donation counts (show the flyer, promo code, order online) in "prep".
- MULTI-DAY: a date range (Spring Break Mar 22–26, a camp week, a trip, a visit) is ONE all-day event with date = the first day and endDate = the last day (inclusive) — not just the first day, and not one event per day. (If each day has its own times, as in a camp with daily hours, still one span; put the daily hours in prep.)
- Extract events with concrete dates only; resolve relative dates ("this Friday", "tomorrow") against the item's received date (provided). Output YYYY-MM-DD.
- FLIGHTS: model a flight as ONE timed event spanning departure→arrival. date + start = the DEPARTURE date/time; end = the ARRIVAL time; endDate = the arrival date ONLY if it lands on a different day (red-eye). Set startTz to the DEPARTURE airport's IANA zone and endTz to the ARRIVAL airport's IANA zone (e.g. LAX → "America/Los_Angeles", EWR/JFK → "America/New_York", ORD → "America/Chicago", DEN → "America/Denver", SEA → "America/Los_Angeles"). Put the flight number in the title or location. This makes the calendar show true block time across zones. A round-trip itinerary = TWO separate flight events (outbound + return). Example: "UA 100 ORD 9:15 AM → BOS 12:40 PM, Jun 19" → {date:"2026-06-19", start:"09:15", end:"12:40", startTz:"America/Chicago", endTz:"America/New_York", title:"Depart for Boston — UA 100", location:"ORD → BOS"}.
- For any non-flight event whose stated times are in a timezone other than Pacific, set startTz (and endTz if different) accordingly; otherwise omit them (defaults to Pacific).
- "prep" on an event = what to bring/wear/prepare. todos: priority=high when time-sensitive or alert; set a due date when there is one. Do NOT restate the due date inside the todo's title/detail — it's shown separately.
- PREP TIMING: a to-do that gets something ready for a dated thing (buy/get/order/make/pack/wrap/print/sign …) is due BEFORE that date, never on it — the kids need it in hand that morning. Default to the day before; give 2–3 days when it must be bought or ordered, and if the day before is a Sunday/holiday, prefer the last practical shopping day. Only the act of BRINGING/turning it in is due on the day itself, and that's usually covered by the event's "prep" note rather than a separate to-do.
- ALREADY KNOWN: the message may include "EXISTING EVENTS" and "OPEN TO-DOS" lists. Different emails often describe the SAME thing (a school digest, a room parent's reminder, a calendar entry). If the input is about something already listed, do NOT create it again: for an event, emit "updates" with the existing id (an empty "set" is fine if nothing changed — it links this message to that event); for a to-do, simply omit it unless the existing one lacks something essential. Only create new items for genuinely new things.
  "The same thing" is strict: the SAME date, the SAME activity, and the same organizer or place (the class spring concert is not the district music festival that evening, even on the same date with a similar theme). A prep to-do ("costumes", "buy a gift") never stands in for its event — the event itself must be on the calendar. When the message announces a dated event and no listed event is clearly that one, CREATE it; a near-duplicate is caught downstream, a missing event is not. Never decide something is "already on the calendar" unless you can point to its line (id) in EXISTING EVENTS — and then emit it in "updates" with that id.
- Coverage notes ("Sam has all drop-offs/pickups Tuesday") → one calendar event for the coverage. Keep light.
- CONTEXT IS NOT A SEPARATE ITEM: when one part of a note only exists to EXPLAIN another, produce a SINGLE item for the actionable/coverage thing and fold the background into its detail — do not spin the context into its own event. E.g. "Alex is at an offsite Tue 9–5, so Sam has all drop-offs/pickups" → ONE event ("Sam: all drop-offs & pickups", owner ["sam"], detail noting Alex is at an offsite) — do NOT also create a "Alex offsite" event. Only give the context its own event if it independently needs to be on the calendar (e.g. the family must plan around it).
- summary: one concise sentence a parent can read at a glance. reason: one sentence on the category choice.

Always respond by calling the file_item tool.`;

const TOOL: Anthropic.Tool = {
  name: "file_item",
  description: "File a classified family item (comm, note, or attachment).",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: ["fyi", "calendar", "action", "alert"] },
      people: {
        type: "array",
        items: { type: "string" },
        description:
          'Who it is FOR / about: family ids ("max","theo","ava","alex","sam") and/or guest names ("Grandma").',
      },
      owner: {
        type: "array",
        items: { type: "string" },
        description:
          'Who is RESPONSIBLE for acting on it — usually "alex" and/or "sam". Default to ["alex","sam"] for actions when unspecified; [] for pure FYI.',
      },
      source: {
        type: "string",
        enum: ["parentsquare", "aeries", "band", "brightwheel", "email", "text", "other"],
      },
      subject: { type: "string" },
      summary: { type: "string" },
      reason: { type: "string" },
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD — start/departure date" },
            allDay: { type: "boolean", description: "true when the message gives no start time" },
            start: { type: "string", description: "HH:mm local to startTz — ONLY a time the message (or a linked page) actually states. Never guess one; if none is given, omit it and set allDay=true." },
            end: { type: "string", description: "HH:mm local to endTz, optional. For a flight, the arrival time." },
            endDate: {
              type: "string",
              description: "YYYY-MM-DD — the LAST day when the event spans days: a break, camp week, or trip (Spring Break Mar 22–26 → date 03-22, endDate 03-26, inclusive), or a red-eye's arrival date. Omit if it's one day.",
            },
            startTz: {
              type: "string",
              description:
                'IANA timezone of the start time, e.g. "America/Los_Angeles". REQUIRED for flights (the departure airport\'s zone) and any event whose times are in a non-Pacific zone. Omit for ordinary local events.',
            },
            endTz: {
              type: "string",
              description:
                'IANA timezone of the end time, e.g. "America/New_York". REQUIRED for flights (the arrival airport\'s zone). Omit if same as startTz.',
            },
            location: { type: "string" },
            prep: { type: "string" },
          },
          required: ["title", "date", "allDay"],
        },
      },
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            due: { type: "string", description: "YYYY-MM-DD, optional" },
            priority: { type: "string", enum: ["normal", "high"] },
            owner: {
              type: "array",
              items: { type: "string" },
              description:
                'OPTIONAL override of who is RESPONSIBLE for THIS to-do, if it differs from the item-level owner. Use for EA-inferred prep to-dos (wrap a gift, bring treats, clear work calendars) — these are parent tasks, so set ["alex","sam"] (or the specific parent) even when the event itself has no owner. Omit to inherit the item-level owner.',
            },
            people: {
              type: "array",
              items: { type: "string" },
              description:
                "OPTIONAL override of who THIS to-do is FOR, if it differs from the item-level people. Omit to inherit.",
            },
          },
          required: ["title", "priority"],
        },
      },
      command: {
        type: "object",
        description: "Set ONLY when the input is an instruction to modify the calendar (e.g. delete/clear events). Otherwise omit.",
        properties: {
          action: { type: "string", enum: ["delete_events", "edit_events"] },
          query: { type: "string", description: "event title to match" },
          from: { type: "string", description: "YYYY-MM-DD inclusive" },
          to: { type: "string", description: "YYYY-MM-DD exclusive" },
          description: { type: "string" },
          set: {
            type: "object",
            description: "For edit_events: the new values to apply.",
            properties: {
              date: { type: "string", description: "new YYYY-MM-DD" },
              start: { type: "string", description: "new HH:mm" },
              end: { type: "string", description: "new HH:mm" },
              location: { type: "string" },
              title: { type: "string" },
            },
          },
        },
        required: ["action", "query", "from", "to", "description"],
      },
      updates: {
        type: "array",
        description:
          "Corrections to EXISTING EVENTS listed in the context, when the input is authoritative (an official schedule, a correction notice, 'the PDF is correct'). Match by the context event's id. Only include fields that change. Usually empty.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "the existing event's id from the EXISTING EVENTS context" },
            set: {
              type: "object",
              properties: {
                title: { type: "string" },
                date: { type: "string", description: "YYYY-MM-DD" },
                start: { type: "string", description: "HH:mm" },
                end: { type: "string", description: "HH:mm" },
                location: { type: "string" },
                prep: { type: "string", description: "notes (what to bring/wear, jersey color, etc.)" },
              },
            },
          },
          required: ["id", "set"],
        },
      },
      deletes: {
        type: "array",
        description:
          "EXISTING EVENTS (by id from context) that should NOT exist per the authoritative input — e.g. a game not on the official schedule, a cancelled event, a duplicate. These are queued for the parents to confirm, so be precise but not timid. Usually empty.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            reason: { type: "string", description: "one line: why it should be removed" },
          },
          required: ["id", "reason"],
        },
      },
      metadata: {
        type: "array",
        description: "Structural changes to family info (teacher/contact/routine/school). Usually empty.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["set_teacher", "set_contact", "set_routine", "set_school"] },
            confident: { type: "boolean", description: "true only if explicit & unambiguous" },
            description: { type: "string", description: "human-readable, e.g. 'Set Max's fall teacher to Ms. X'" },
            kidId: { type: "string", enum: ["max", "theo", "ava"] },
            term: { type: "string", enum: ["current", "fall"] },
            teachers: { type: "array", items: { type: "string" } },
            name: { type: "string" },
            role: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            label: { type: "string", description: "Drop-off or Pick-up" },
            detail: { type: "string" },
            school: { type: "string" },
          },
          required: ["kind", "confident", "description"],
        },
      },
    },
    required: ["category", "people", "owner", "source", "subject", "summary", "reason", "events", "todos", "updates", "deletes", "metadata"],
  },
};

export async function classify(input: {
  from: string;
  subject: string;
  text: string;
  receivedAt: string; // ISO
  attachments?: Attachment[];
  context?: string; // e.g. reference dates for resolving relative references
}): Promise<Classification> {
  const atts = input.attachments || [];
  const note = atts.length
    ? `\n\n[This item includes ${atts.length} attached image(s)/PDF(s) — often a flyer, confirmation, or calendar. Read them carefully for dates, actions, and what to bring.]`
    : "";

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: `Received at: ${input.receivedAt}
From: ${input.from}
Subject: ${input.subject}
${input.context ? input.context + "\n" : ""}
${input.text}${note}`,
    },
  ];
  for (const a of atts) {
    if (a.kind === "image") {
      content.push({ type: "image", source: { type: "base64", media_type: a.mediaType as "image/png", data: a.data } });
    } else {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } });
    }
  }

  // Multi-page PDFs (season schedules, packets) need reliable table extraction —
  // worth a stronger model. Everything else stays on the fast/cheap default.
  const hasPdf = atts.some((a) => a.kind === "pdf");
  const model = hasPdf ? process.env.CLASSIFY_MODEL_PDF || "claude-sonnet-4-6" : MODEL;

  const msg = await anthropic.messages.create({
    model,
    // Generous output budget: a full season schedule can be dozens of events.
    max_tokens: 8192,
    // Not cached: emails arrive minutes apart, so a cached copy was written every time and never read.
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "file_item" },
    messages: [{ role: "user", content }],
  });
  recordUsage(hasPdf ? "classify_pdf" : "classify", model, msg.usage);

  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("classifier did not return structured output");
  }
  const c = block.input as Classification;
  // Defensive defaults so callers can iterate without null checks.
  c.events ||= [];
  c.todos ||= [];
  c.updates ||= [];
  c.deletes ||= [];
  c.metadata ||= [];
  // A time the message never states is a guess (a model will invent "10:00" for an event with no
  // time given): drop it and keep the event all-day. Skipped when attachments carry the details.
  if (!atts.length) {
    const said = `${input.subject}\n${input.text}`;
    for (const e of c.events) {
      if (e.start && !timeStated(said, e.start)) {
        delete e.start;
        delete e.end;
        e.allDay = true;
      }
    }
  }
  return c;
}

/** Is this HH:mm time actually written in the text? ("10:00", "10am", "10 a.m.", "at 10", "9–10am", "noon") */
export function timeStated(text: string, hhmm: string): boolean {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const t = text.toLowerCase();
  const h12 = ((h + 11) % 12) + 1;
  const mm = String(m).padStart(2, "0");
  if (h === 12 && m === 0 && /\bnoon\b/.test(t)) return true;
  const ampm = "(a\\.?m\\.?|p\\.?m\\.?)";
  const pats = [`\\b${h12}:${mm}\\b`, `\\b${String(h).padStart(2, "0")}:${mm}\\b`, `\\b${h12}\\.${mm}\\s*${ampm}`];
  if (m === 0) pats.push(`\\b${h12}\\s*${ampm}`, `\\b${h12}\\s*o'?clock`, `\\bat ${h12}\\b`, `\\b${h12}\\s*[-–—]\\s*\\d{1,2}(:\\d\\d)?\\s*${ampm}`);
  return pats.some((p) => new RegExp(p).test(t));
}

const VERIFY_TOOL: Anthropic.Tool = {
  name: "verify_items",
  description: "Verdict for each proposed calendar change, checked against the source document.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            idx: { type: "number", description: "the proposed change's number" },
            keep: { type: "boolean" },
            evidence: {
              type: "string",
              description: "the exact source row text that justifies the verdict (or why no row matches)",
            },
          },
          required: ["idx", "keep", "evidence"],
        },
      },
    },
    required: ["results"],
  },
};

/**
 * Independent second pass over a document extraction: re-checks each proposed
 * calendar change against the source, row by row. Catches the classic table
 * failures — rows pulled from the wrong league/division (identical team labels
 * exist in several), invented rows, and deletions proposed for rows that are
 * actually present. Returns the indices to KEEP.
 */
export async function verifyExtraction(input: {
  attachments: Attachment[];
  instructions: string;
  items: string[]; // human-readable proposed changes, indexed 0..n-1
}): Promise<Set<number>> {
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: `A first pass extracted the following proposed calendar changes from the attached document, applying the user's instructions.

USER INSTRUCTIONS:
${input.instructions}

PROPOSED CHANGES:
${input.items.map((it, i) => `${i}. ${it}`).join("\n")}

Independently verify EACH proposed change against the document, row by row:
- ADD / UPDATE items: keep=true only if a source row exists whose EVERY relevant cell matches — date, time, location, AND every filter in the user's instructions. League/division must match character-for-character: the same team labels (Team A, Team B…) exist in MULTIPLE divisions playing at the same fields, so re-read the league cell of the exact row. If the row is from a different division, keep=false.
- DELETE items: keep=true only if NO in-scope row matches that event (it truly is not on the schedule). If you find a matching row, keep=false.
Quote the decisive source row as evidence. Be strict — a wrong calendar entry is worse than a missing one.`,
    },
  ];
  for (const a of input.attachments) {
    if (a.kind === "image") {
      content.push({ type: "image", source: { type: "base64", media_type: a.mediaType as "image/png", data: a.data } });
    } else {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } });
    }
  }
  const msg = await anthropic.messages.create({
    model: process.env.CLASSIFY_MODEL_PDF || "claude-sonnet-4-6",
    max_tokens: 4096,
    tools: [VERIFY_TOOL],
    tool_choice: { type: "tool", name: "verify_items" },
    messages: [{ role: "user", content }],
  });
  recordUsage("verify", process.env.CLASSIFY_MODEL_PDF || "claude-sonnet-4-6", msg.usage);
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("verifier did not return structured output");
  const results = ((block.input as any).results || []) as { idx: number; keep: boolean; evidence: string }[];
  const keep = new Set<number>();
  for (const r of results) if (r.keep) keep.add(r.idx);
  for (const r of results) if (!r.keep) console.log("verify rejected:", input.items[r.idx], "—", r.evidence);
  return keep;
}
