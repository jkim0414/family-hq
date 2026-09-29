// Dummy data for demo screenshots. Nothing here is real: kids, schools, contacts,
// events, purchases and messages are all made up. "Today" is Mon Sep 28, 2026.
const D = (offset: number) => new Date(Date.UTC(2026, 8, 28 + offset, 12)).toISOString().slice(0, 10);
const T = (offset: number, hhmm: string) => new Date(`${D(offset)}T${hhmm}:00-07:00`).toISOString();

export const kids = [
  { id: "max", firstName: "Max", fullName: "Max Carter", dob: "2018-07-22", color: "#2563eb", current: { school: "Maple Grove Elementary", program: "3rd Grade", teachers: ["Ms. Rivera"], aftercare: "Maple Grove After-School" }, fall: { school: "Maple Grove Elementary", program: "3rd Grade", teachers: ["Ms. Rivera"], aftercare: "Maple Grove After-School" }, channels: ["parentsquare", "email"] },
  { id: "theo", firstName: "Theo", fullName: "Theo Carter", dob: "2021-05-03", color: "#16a34a", current: { school: "Maple Grove Elementary", program: "Kindergarten", teachers: ["Mr. Okafor"], aftercare: "Maple Grove After-School" }, fall: { school: "Maple Grove Elementary", program: "Kindergarten", teachers: ["Mr. Okafor"], aftercare: "Maple Grove After-School" }, channels: ["parentsquare", "email"] },
  { id: "ava", firstName: "Ava", fullName: "Ava Carter", dob: "2023-02-17", color: "#db2777", current: { school: "Sunny Days Preschool", program: "Twos", teachers: ["Ms. Priya", "Ms. Dana"] }, fall: { school: "Sunny Days Preschool", program: "Twos", teachers: ["Ms. Priya", "Ms. Dana"] }, channels: ["email"] },
];

export const places = [
  { id: "p1", name: "Maple Grove Elementary", kind: "school", address: "200 Maple Ave, Springfield", phone: "(555) 010-0141", notes: "Max (3rd) and Theo (kindergarten)." },
  { id: "p2", name: "Maple Grove After-School", kind: "aftercare", address: "On campus", notes: "Pickup by 6pm, Gate 3." },
  { id: "p3", name: "Sunny Days Preschool", kind: "daycare", address: "88 Elm St, Springfield", phone: "(555) 010-0177" },
];

export const contacts = [
  { id: "c1", name: "Ms. Rivera", role: "Teacher — Max's 3rd grade", kidIds: ["max"], org: "Maple Grove Elementary", email: "rivera@example.org" },
  { id: "c2", name: "Mr. Okafor", role: "Teacher — Theo's kindergarten", kidIds: ["theo"], org: "Maple Grove Elementary", email: "okafor@example.org" },
  { id: "c3", name: "Coach Pat", role: "Soccer coach (Max)", kidIds: ["max"], phone: "+15550100122" },
  { id: "c4", name: "Jess Park", role: "Babysitter", kidIds: [], phone: "+15550100188", venmo: "example" },
];

export const routines = [
  { id: "r1", kidId: "max", label: "Drop-off", detail: "8:05 at the front gate" },
  { id: "r2", kidId: "max", label: "Pick-up", detail: "After-school, by 6pm" },
  { id: "r3", kidId: "ava", label: "Pick-up", detail: "Sunny Days, by 5:30" },
];

export const events = [
  { id: "e1", title: "Picture Day", date: D(0), allDay: true, people: ["max", "theo"], prep: "Blue shirts; retake form in backpack.", source: "parentsquare" },
  { id: "e2", title: "Theo — swim lesson", date: D(0), start: "16:30", end: "17:00", startTz: "America/Los_Angeles", endTz: "America/Los_Angeles", allDay: false, people: ["theo"], owner: ["sam"], location: "Riverside Aquatic Center, 1 Pool Ln, Riverside", travelMin: 14, travelFor: "Riverside Aquatic Center, 1 Pool Ln, Riverside" },
  { id: "e3", title: "Back-to-School Night", date: D(1), start: "18:00", end: "19:30", startTz: "America/Los_Angeles", endTz: "America/Los_Angeles", allDay: false, people: ["max", "theo"], owner: ["alex", "sam"], location: "Maple Grove Elementary", source: "email" },
  { id: "e4", title: "Max's soccer game vs. Tigers", date: D(5), start: "09:30", end: "10:30", startTz: "America/Los_Angeles", endTz: "America/Los_Angeles", allDay: false, people: ["max"], location: "Central Park, Springfield", travelMin: 11, travelFor: "Central Park, Springfield", prep: "Snack family: us." },
  { id: "e5", title: "Maya's 6th birthday party", date: D(5), start: "14:00", end: "16:00", startTz: "America/Los_Angeles", endTz: "America/Los_Angeles", allDay: false, people: ["max", "theo", "ava"], location: "Lakeside Park, Oakdale", travelMin: 34, travelFor: "Lakeside Park, Oakdale", prep: "RSVP'd yes for all three (Paperless Post). Gift: art supplies.", source: "email" },
  { id: "e6", title: "Pumpkin patch field trip", date: D(9), start: "09:00", end: "13:00", startTz: "America/Los_Angeles", endTz: "America/Los_Angeles", allDay: false, people: ["theo"], location: "Harvest Pumpkin Farm, Hillside", travelMin: 32, travelFor: "Harvest Pumpkin Farm, Hillside", prep: "Closed-toe shoes, sack lunch.", source: "parentsquare" },
  { id: "e7", title: "No School — Thanksgiving Break", date: "2026-11-23", endDate: "2026-11-27", allDay: true, people: ["max", "theo"], source: "other" },
];

export const todos = [
  { id: "t1", title: "Return Theo's field trip permission slip", due: D(1), people: ["theo"], owner: ["sam"], priority: "high", done: false, source: "parentsquare" },
  { id: "t2", title: "Buy a gift for Maya's party", detail: "Art supplies — she loves painting.", due: D(2), people: ["max", "theo", "ava"], owner: ["alex"], priority: "normal", done: false },
  { id: "t3", title: "Bring orange slices for soccer (our week)", due: D(4), people: ["max"], owner: ["alex"], priority: "normal", done: false },
  { id: "t4", title: "Wrap Maya's gift + sign the card", due: D(4), people: ["max", "theo", "ava"], owner: ["sam"], priority: "normal", done: false },
  { id: "t5", title: "Pack sack lunch for pumpkin patch", due: D(8), people: ["theo"], owner: ["sam"], priority: "normal", done: false },
  { id: "t6", title: "RSVP to Maya's party", people: ["max", "theo", "ava"], priority: "normal", done: true },
];

export const actions = [
  {
    id: "a1", kind: "confirm_step", status: "proposed",
    title: "Order Nature Valley granola bars, 12 ct — $13.87 on Amazon",
    summary: 'Browser task "Order granola bars on Amazon" is asking to proceed.',
    payload: { taskId: "task-web-demo", description: "Order 1× Nature Valley Oats 'n Honey granola bars, 12 ct, on amazon.com — $12.99 + tax = $13.87, Prime to home (arrives Wed), pay with Family Visa ending 4242. Allergen statement checked: no sesame.", url: "https://www.amazon.com/", hasScreenshot: false },
    createdAt: T(0, "08:03"), taskId: "task-web-demo", requestedBy: "agent", channel: "app",
  },
];

export const spending = [
  { id: "s1", date: D(-1), merchant: "Amazon", amount: 21.48, currency: "USD", description: "Kids' art supply set", cardLast4: "4242", account: "alex", byKimi: true, source: "email", createdAt: T(-1, "10:00") },
  { id: "s2", date: D(-2), merchant: "Instacart", amount: 142.37, currency: "USD", description: "Weekly groceries", account: "sam", source: "email", createdAt: T(-2, "10:00") },
  { id: "s3", date: D(-3), merchant: "Springfield Youth Soccer", amount: 185.0, currency: "USD", description: "Fall season registration (Max)", account: "alex", byKimi: true, source: "email", createdAt: T(-3, "10:00") },
  { id: "s4", date: D(-5), merchant: "Sunny Days Preschool", amount: 1450.0, currency: "USD", description: "October tuition", account: "sam", source: "email", createdAt: T(-5, "10:00") },
  { id: "s5", date: D(-6), merchant: "Maple Grove PTA", amount: 60.0, currency: "USD", description: "Fall Festival tickets", account: "alex", source: "email", createdAt: T(-6, "10:00") },
  { id: "s6", date: D(-8), merchant: "Target", amount: 54.19, currency: "USD", description: "Rain boots ×2", cardLast4: "4242", account: "alex", byKimi: true, source: "email", createdAt: T(-8, "10:00") },
  { id: "s7", date: D(-9), merchant: "DoorDash", amount: 38.62, currency: "USD", description: "Pho delivery", account: "sam", source: "email", createdAt: T(-9, "10:00") },
  { id: "s8", date: D(-12), merchant: "Riverside Aquatics", amount: 120.0, currency: "USD", description: "Swim lessons, 6 sessions (Theo)", account: "sam", source: "email", createdAt: T(-12, "10:00") },
  { id: "s9", date: D(-15), merchant: "Costco", amount: 212.9, currency: "USD", description: "Household restock", account: "alex", source: "email", createdAt: T(-15, "10:00") },
];

export const comms = [
  { id: "m1", receivedAt: T(-1, "16:20"), source: "email", category: "calendar", subject: "You're invited: Maya's 6th Birthday!", summary: "Birthday party Sat 2–4pm at Lakeside Park, Oakdale. RSVP by Wed.", reason: "An invitation with a date, time, and RSVP.", people: ["max", "theo", "ava"] },
  { id: "m2", receivedAt: T(-2, "09:05"), source: "parentsquare", category: "action", subject: "Kindergarten Pumpkin Patch Field Trip — permission slip due", summary: "Permission slip due Tuesday; trip is Wed Oct 7.", reason: "A form with a deadline.", people: ["theo"] },
  { id: "m3", receivedAt: T(-3, "13:40"), source: "email", category: "fyi", subject: "Maple Grove Weekly Update", summary: "Library books due Fridays; lost & found moves to the gym.", reason: "School newsletter, nothing to act on.", people: ["max", "theo"] },
];

export const audit = [
  { id: "au1", at: T(0, "08:03"), kind: "proposed", summary: "Asked to order granola bars on Amazon ($13.87)", by: "hq" },
  { id: "au2", at: T(-1, "16:22"), kind: "executed", summary: "Filed Maya's birthday party + 2 to-dos", by: "hq" },
];

export const profile = {
  sections: [
    { key: "allergies", title: "Allergies & medical", body: "Theo: sesame allergy. Always read the allergen statement before buying food." },
    { key: "work", title: "Work & availability", body: "Alex and Sam both work; work calendars are shared with Kimi for planning only." },
    { key: "childcare", title: "Childcare & coverage", body: "A sitter covers Tuesday pickups." },
    { key: "vendors", title: "Go-to vendors", body: "Groceries via Instacart. Birthday gifts: art supplies." },
  ],
  people: [
    { id: "pp1", name: "Jess Park", relation: "Service", note: "Babysitter", venmo: "example" },
    { id: "pp2", name: "The Nguyens", relation: "Friend family", note: "Maya's parents" },
  ],
};

// The shared family chat.
export const chatLog = [
  { at: T(-1, "19:02"), kind: "user", who: "Sam", text: "Did we RSVP to Maya's party?" },
  { at: T(-1, "19:02"), kind: "tool", text: "search_email: Sam's inbox — \"Maya birthday\"" },
  { at: T(-1, "19:02"), kind: "tool", text: "read_link: paperlesspost.com — invitation page" },
  { at: T(-1, "19:03"), kind: "assistant", text: "Yes — you RSVPed **yes for all three** on Sunday (it's in your inbox, and the Paperless Post page shows you as attending).\n\nIt's **Saturday 2–4pm at Lakeside Park in Oakdale**, about 35 minutes away, so leave by 1:20. I added \"Buy a gift\" for Wednesday and \"Wrap + card\" for Friday." },
  { at: T(-1, "21:15"), kind: "user", who: "Alex", text: "When could we get away for a few days this fall?" },
  { at: T(-1, "21:15"), kind: "tool", text: "read_link: district 2026–27 school calendar" },
  { at: T(-1, "21:15"), kind: "tool", text: "get_work_calendar: Alex + Sam, Oct–Nov" },
  { at: T(-1, "21:16"), kind: "tool", text: "get_upcoming: family calendar, next 60 days" },
  { at: T(-1, "21:16"), kind: "assistant", text: "**Thanksgiving week is the best window.** Max and Theo are off Nov 23–27 per the district calendar, and Sunny Days closes the 26th–27th.\n\n• **Alex:** two calls Monday the 23rd you could move; nothing after.\n• **Sam:** meetings Mon–Tue, clear from Wednesday.\n• **Family calendar:** nothing that week.\n\nMy pick: **fly out Sat Nov 21, back Sun Nov 29.** Two other options, Veterans Day weekend or Oct 16–19, are in the file below." },
  { at: T(0, "07:58"), kind: "user", who: "Alex", text: "Can you order another box of those granola bars the kids like?" },
  { at: T(0, "07:58"), kind: "assistant", text: "On it. I'll get the same Oats 'n Honey bars (no sesame), check the allergen statement on the product page, and stop at checkout for your OK." },
  { at: T(0, "08:12"), kind: "user", who: "Sam", text: "Also can you set up Venmo for Jess? $80 for Saturday night." },
  { at: T(0, "08:12"), kind: "assistant", text: "Ready — I didn't send anything:\n\n[Pay Jess Park $80.00 in Venmo](https://venmo.com/)\n\nCheck the amount and recipient in Venmo before you confirm." },
];

export const tasks = [
  { id: "task-web-demo", title: "Order granola bars on Amazon", status: "waiting", kind: "browser", owner: "alex", channel: "app", createdAt: T(0, "07:58"), updatedAt: T(0, "08:03") },
];

export const files = [
  { id: "f1", title: "Fall getaway options", url: "https://example.com/f/demo", createdAt: T(-1, "21:16"), public: false },
];
