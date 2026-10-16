import { HOME_TZ } from "./tz.js";
// ─────────────────────────────────────────────────────────────────────────────
// Your household's configuration. EDIT THIS for your family.
// The two parents' ids ("alex", "sam") are used throughout the code as the
// people who can log in; rename them with a project-wide find-and-replace if
// you like, and keep src/data/people.ts in step.
// ─────────────────────────────────────────────────────────────────────────────

export const CONFIG = {
  parents: {
    alex: { name: "Alex Carter", email: "alex@example.com", phone: "+15550100001" },
    sam: { name: "Sam Carter", email: "sam@example.com", phone: "+15550100002" },
  },

  // Where each parent works: mail about their job (meetings, events at their workplace) is work,
  // not family business — never filed onto the family calendar.
  workplaces: {
    // EDIT: each parent's employer and work email domains.
    alex: { org: "Acme Corp", domains: ["acme.example"] },
    sam: { org: "Globex", domains: ["globex.example"] },
  } as Record<string, { org: string; domains: string[] }>,

  // Work-calendar holds: a family event during a parent's working hours gets a "DNS – <event>" hold
  // on their work calendar, so whoever books their meetings (and can't see the family calendar) works
  // around it. Some work calendars can't be shared for editing, so the hold is an invitation to the work address from a calendar of its own in the family's Google
  // account — kept out of the family calendar and out of the app.
  workHolds: {
    // EDIT: per parent, a calendar of its own in the family Google account (its Calendar ID), e.g.
    // alex: { calendarId: "…@group.calendar.google.com", hours: ["08:00", "18:00"] },
  } as Record<string, { calendarId: string; hours: [string, string] }>,

  // Whose work-calendar entries without other attendees can be real commitments (a standing meeting,
  // a shift), not just self-placed holds. Kimi judges each one, and asks them when unsure.
  judgeAttendeeless: [] as string[], // EDIT: e.g. ["alex"] for a parent whose solo calendar entries are often commitments

  // Other household members who use Kimi. A caregiver sees the family calendar, to-dos, kids,
  // household facts and inboxes, and has her own private chat; she doesn't see the parents' chat,
  // spending, logins/cards, or work-calendar details, and anything that costs money waits for a
  // parent's approval. "callMe" is what Kimi calls her. Kimi texts her
  // (sms: true) once she opts in with START + Y, like the parents. Sign-in needs an email.
  caregivers: {
    grandma: { name: "Grandma Carter", callMe: "Grandma", email: "", phone: "+15550100101", sms: false },
  },

  // Where dated kid events are written (a Google Calendar id — usually the email
  // of the Google account you connect under Kimi → Connections).
  calendar: {
    targetCalendarId: "alex@example.com",
    // Every kid-related event invites these guests.
    alwaysInvite: ["sam@example.com"],
    timeZone: HOME_TZ,
    // Mirror events added directly to that calendar into the app (and infer prep to-dos).
    importPersonal: true,
  },

  // Airports the family flies from: a work-calendar trip hold to anywhere else is "traveling".
  homeAirports: [] as string[], // EDIT: e.g. ["JFK", "LGA"]

  // Identifying strings that appear only in prose (work domains, a surname): the public-bundle
  // check (build-checks/bundle-pii.ts) fails the build if one ships.
  bundleTerms: [] as string[], // EDIT: e.g. your work email domains, a surname

  // Optional dedicated inbox that parents forward school email to (read over IMAP;
  // credentials in .env.local / your host's environment, never in code).
  intake: {
    address: "school-inbox@example.com",
    imapHost: "imap.gmail.com",
    provider: "gmail",
  },

  // Digest schedule (the digests themselves are sent by email from /api/digest).
  digest: {
    channel: "email" as const,
    recipients: [] as string[],
    dailyTime: "07:00",
    weeklyDay: "Sunday",
    weeklyTime: "17:00",
  },
};
