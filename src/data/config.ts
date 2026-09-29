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

  // Where dated kid events are written (a Google Calendar id — usually the email
  // of the Google account you connect under Kimi → Connections).
  calendar: {
    targetCalendarId: "alex@example.com",
    // Every kid-related event invites these guests.
    alwaysInvite: ["sam@example.com"],
    timeZone: "America/Los_Angeles",
    // Mirror events added directly to that calendar into the app (and infer prep to-dos).
    importPersonal: true,
  },

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
