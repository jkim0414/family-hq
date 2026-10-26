#!/usr/bin/env tsx
// Email from someone in the family to Kimi's inbox (not a forward) is a message to Kimi: only when
// Gmail authenticated the sender, in the right chat, with what they replied to. No network.
import { senderVerified } from "../api/_lib/imap";
import { noteFrom, noteThread, noteText } from "../api/_lib/email-notes";
import { CONFIG } from "../src/data/config";
import type { RawMessage } from "../api/_lib/imap";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
const alex = CONFIG.parents.alex.email, sam = CONFIG.parents.sam.email;
const msg = (x: Partial<RawMessage>): RawMessage => ({ uid: 1, date: new Date().toISOString(), from: `Parent <${sam}>`, subject: "Re: Bake sale", text: "All set.", attachments: [], recipients: ["kimi@example.com", alex], fromVerified: true, ...x });

const parsed = (ar: string, from = sam) => ({ headers: new Map([["authentication-results", ar]]), from: { value: [{ address: from }] } });
const dom = sam.split("@")[1];
check("Gmail's DMARC pass counts as verified", senderVerified(parsed(`mx.google.com; dkim=pass header.i=@${dom}; spf=pass; dmarc=pass (p=NONE) header.from=${dom}`)));
check("DKIM pass for the sender's own domain counts", senderVerified(parsed(`mx.google.com; dkim=pass header.i=@${dom} header.s=x; spf=neutral`)));
check("a forged From (DMARC fail, no DKIM for the domain) doesn't", !senderVerified(parsed(`mx.google.com; dkim=pass header.i=@spammer.example; spf=fail; dmarc=fail header.from=${dom}`)));
check("no Gmail verdict at all doesn't", !senderVerified(parsed(`other.example; dmarc=pass`)));

check("a parent's reply to Kimi is a note from them", noteFrom(msg({})) === "sam");
check("…not when Gmail couldn't verify the sender", noteFrom(msg({ fromVerified: false })) === null);
check("a forward is filed, not a note", noteFrom(msg({ subject: "Fwd: Field trip" })) === null && noteFrom(msg({ subject: "Field trip", text: "---------- Forwarded message ---------\nFrom: school" })) === null);
check("someone outside the family isn't a note", noteFrom(msg({ from: "PTA <pta@example.org>" })) === null);
check("the other parent on it → the parents' chat", noteThread("sam", msg({})) === "task-main");
check("just them → their own chat", noteThread("sam", msg({ recipients: ["kimi@example.com"] })) === "task-private-sam");
const t = noteText(msg({ text: "Already covered, skip it\nSent from my iPhone\n\nOn Tue, Mar 4, 2031 at 9:00 AM Kimi <kimi@example.com> wrote:\n> Action needed\n> Bring napkins to the bake sale Friday" }));
check("what they wrote leads, the sign-off goes", t.includes("Already covered, skip it") && !/Sent from my iPhone/.test(t));
check("…with what they replied to, for context", /replying to: .*napkins/.test(t));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
