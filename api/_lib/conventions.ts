// House rules for turning an event into prep to-dos, shared VERBATIM by the
// email/attachment classifier and the chat assistant — so the same party
// produces the same to-dos no matter which way it reached Kimi.

export const PREP_CONVENTIONS = `PREP CONVENTIONS — use exactly these, one to-do per distinct action (never combine two actions like "Gift + costumes" into one item):
- Another child's birthday party our kids attend:
  • "RSVP to <Child>'s party" — only if an RSVP is requested; due the RSVP deadline, otherwise 7 days before.
  • "Buy a gift for <Child>" — due 3 days before. Skip if the invite says no gifts.
  • "Wrap gift for <Child>" and "Write a card for <Child>" — two to-dos, both due the day before.
  • "Pack allergy-safe treats for <Child>'s party" — due the day before (per the household's allergies).
  • Themed or costume party (Halloween, "boo", superhero, princess, "dress up as…") → "Costumes for <our kids> (<theme>)" — due 3 days before.
  Name the birthday child as fully as the message allows (first name + the host family's surname, e.g. "Theo Nguyen") so two parties the same weekend never blur together.
- Our own kid's party → "Order food for <kid>'s party" per the profile's vendors, due 5 days before.
- Something a kid must bring in (flowers, snacks, supplies) → "Buy <item> for <kid/class>", due the day before (2–3 days if it must be ordered).
- Potluck / bring a dish → "Make or buy a dish for <event>", due the day before.
- Field trip → "Sign permission slip for <trip>" (the form's deadline) and "Pack a bag lunch for <kid>" (the day before).
- A kid's event during a parent's work hours → "Clear work calendar for <event>", due 2 days before.
Prep is PARENT work: owner = the responsible parent(s), default ["alex","sam"]; people = the kid(s) it's for.`;

export const NAME_COLLISIONS = `NAMES THAT MATCH OUR KIDS: other families' children often share our kids' names (another "Theo", another "Max"). When an invitation or message comes FROM another family (the host or sender isn't Alex or Sam), a child named as the birthday child or host is THEIR child, not ours. Call them "<Name> <Surname>" (e.g. "Theo Nguyen") in titles and to-dos, and never put our kid's id in "people" because of the name.
WHO IS INVITED: "people" (on the item, the event, and each prep to-do) = OUR kids who are invited, read from the addressee/greeting line — every one of them. "Max & Theo & fam" → ["max","theo","ava"] ("& fam"/"& family" means all three of our kids). "Max" alone → ["max"].`;

// ── Enforcement ──────────────────────────────────────────────────────────────
// The model follows the conventions most of the time, not every time. For the
// most common case — another child's birthday party — guarantee the checklist
// in code so every invitation yields the same to-dos no matter how it arrived.

import type { Classification } from "./classify.js";

const OUR_KIDS = ["Max", "Theo", "Ava"];
const LEAD_WORDS = new Set(["celebrate", "join", "come", "happy", "race", "party", "invitation", "invited", "rsvp", "welcome", "it's", "its"]);
const PARTY_RE = /\b(birthday|bday|b-day)\b|\bturning \d|\d+(st|nd|rd|th) (birthday|bday)/i;

/** "Maya's 6th Birthday Party" → "Maya"; "Theo Nguyen's party" → "Theo Nguyen"; null if unclear. */
function birthdayChild(title: string): string | null {
  const m = title.match(/((?:[A-Z][\w-]+ ){0,2}[A-Z][\w-]+)['’]s\b/);
  if (!m) return null;
  const words = m[1].split(" ").filter((w) => !LEAD_WORDS.has(w.toLowerCase()));
  return words.length ? words.join(" ") : null;
}

const shift = (date: string, days: number) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Make sure every other-child birthday party carries the standard prep to-dos.
 * Our own kids' parties (a bare "Theo's …") are left to the model.
 */
export function completePartyPrep(c: Classification, sourceText: string, eventsOverride?: { title: string; date: string }[]): void {
  const events = eventsOverride ?? c.events;
  const noGifts = /no gifts|gifts? not necessary|in lieu of gifts/i.test(sourceText);
  const themed = /costume|halloween|\bboo\b|boo'?tastic|spooky|dress[- ]up|dress up as/i.test(sourceText);
  for (const e of events) {
    if (!PARTY_RE.test(e.title) && !PARTY_RE.test(sourceText.slice(0, 400))) continue;
    const child = birthdayChild(e.title);
    if (!child || OUR_KIDS.includes(child)) continue; // unknown, or one of ours
    const people = c.people.filter((p) => ["max", "theo", "ava"].includes(p));
    const has = (re: RegExp) => c.todos.some((t) => re.test(t.title));
    const add = (title: string, daysBefore: number) =>
      c.todos.push({ title, due: shift(e.date, -daysBefore), priority: "normal", owner: ["alex", "sam"], people: people.length ? people : undefined });
    if (!noGifts && !has(/\b(buy|get|pick up|order)\b.*\bgift|\bgift\b.*\b(buy|get)\b/i)) add(`Buy a gift for ${child}`, 3);
    if (!noGifts && !has(/\bwrap\b/i)) add(`Wrap gift for ${child}`, 1);
    if (!has(/\bcard\b/i)) add(`Write a card for ${child}`, 1);
    if (!has(/treat|cupcake|snack/i)) add(`Pack allergy-safe treats for ${child}'s party`, 1);
    if (/\brsvp\b/i.test(sourceText) && !has(/\brsvp\b/i)) add(`RSVP to ${child}'s party`, 7);
    const names = people.map((p) => p[0].toUpperCase() + p.slice(1));
    const who = names.length ? names.join(" & ").replace(/ & (?=.* & )/g, ", ") : "the kids";
    if (themed && !has(/costume/i)) add(`Costumes for ${who} (${/halloween|boo|spooky/i.test(sourceText) ? "Halloween theme" : "party theme"})`, 3);
  }
}
