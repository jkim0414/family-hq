import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { htmlToText } from "../../src/data/text.js";
import { extractLinks, type Link } from "./links.js";

export interface Attachment {
  kind: "image" | "pdf";
  mediaType: string; // e.g. image/png, application/pdf
  data: string; // base64
}

export interface RawMessage {
  uid: number;
  date: string; // ISO
  from: string;
  subject: string;
  text: string;
  attachments: Attachment[];
  /** Links found in the body (labelled when the HTML part had anchors). */
  links?: Link[];
}

/** Plain text of a message (HTML-only mail is converted), plus its links. */
export function bodyOf(parsed: { text?: string; html?: string | false }): { text: string; links: Link[] } {
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text = (parsed.text || (html ? htmlToText(html.replace(/<style[\s\S]*?<\/style>/gi, " ")) : "")).trim().slice(0, 8000);
  return { text, links: extractLinks(parsed.text || "", html) };
}

const IMG_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function extractAttachments(parsed: { attachments?: Array<{ contentType?: string; content?: Buffer }> }): Attachment[] {
  const out: Attachment[] = [];
  for (const a of parsed.attachments || []) {
    const ct = (a.contentType || "").toLowerCase();
    const isImg = IMG_TYPES.has(ct);
    const isPdf = ct === "application/pdf";
    if (!isImg && !isPdf) continue;
    if (!a.content || a.content.length > 4_500_000) continue; // ~4.5MB cap
    out.push({
      kind: isImg ? "image" : "pdf",
      mediaType: isImg ? ct : "application/pdf",
      data: a.content.toString("base64"),
    });
    if (out.length >= 6) break;
  }
  return out;
}

// Fetch unseen messages from the dedicated inbox. Optionally mark them \Seen.
export async function fetchUnseen(markSeen = false): Promise<RawMessage[]> {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!user || !pass) throw new Error("Missing IMAP_USER/IMAP_PASS");

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  client.on("error", (e: unknown) => console.error("imap error", String(e)));

  const out: RawMessage[] = [];
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const body = bodyOf(parsed);
      out.push({
        uid,
        date: parsed.date?.toISOString() ?? new Date().toISOString(),
        from: parsed.from?.text ?? "",
        subject: parsed.subject ?? "",
        text: body.text,
        links: body.links,
        attachments: extractAttachments(parsed),
      });
    }
    if (markSeen && uids.length) {
      await client.messageFlagsAdd(uids.join(","), ["\\Seen"], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

export interface MailHit {
  date: string;
  from: string;
  subject: string;
  snippet: string;
  account: "school" | "personal" | "alex" | "sam";
  /** For read_email: "<account>:<uid>" (IMAP) or "gmail:<account>:<id>" (Gmail API). */
  id?: string;
}

/** One email in full, for read_email. */
export interface MailMessage {
  date: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  links: Link[];
  attachments: string[];
}

export type MailAccount = "school" | "personal" | "alex" | "sam";

// school  → the dedicated forwarding inbox (IMAP_USER/PASS)
// alex   → Alex's own Gmail via app password (GMAIL_IMAP_ALEX_USER/PASS; PERSONAL_IMAP_* is the legacy alias)
// sam     → Sam's own Gmail via app password (GMAIL_IMAP_SAM_USER/PASS)
function accountCreds(account: MailAccount): { user: string; pass: string } | null {
  let user: string | undefined;
  let pass: string | undefined;
  if (account === "school") {
    user = process.env.IMAP_USER;
    pass = process.env.IMAP_PASS;
  } else if (account === "sam") {
    user = process.env.GMAIL_IMAP_SAM_USER;
    pass = process.env.GMAIL_IMAP_SAM_PASS;
  } else {
    user = process.env.GMAIL_IMAP_ALEX_USER || process.env.PERSONAL_IMAP_USER;
    pass = process.env.GMAIL_IMAP_ALEX_PASS || process.env.PERSONAL_IMAP_PASS;
  }
  return user && pass ? { user, pass } : null;
}

export function personalInboxConfigured(): boolean {
  return !!accountCreds("alex");
}

/** True when that parent's Gmail is reachable over IMAP (app password set). */
export function inboxConfigured(account: MailAccount): boolean {
  return !!accountCreds(account);
}

/** The mailbox address an account resolves to (for display), or "". */
export function inboxAddress(account: MailAccount): string {
  return accountCreds(account)?.user || "";
}

/**
 * Search an inbox (the dedicated school inbox by default; the personal one if
 * PERSONAL_IMAP_* is configured). Returns newest-first envelopes; short result
 * sets also get a plain-text snippet. Read-only — never marks anything seen.
 */
export async function searchMail(opts: {
  query?: string;
  days?: number;
  account?: MailAccount;
  limit?: number;
  /** Gmail terms always applied (e.g. "-in:sent"), whatever the query says. */
  exclude?: string;
}): Promise<MailHit[]> {
  const account = opts.account || "school";
  const creds = accountCreds(account);
  if (!creds) throw new Error(account === "school" ? "Missing IMAP_USER/IMAP_PASS" : `${account}'s Gmail isn't connected (no app password set).`);
  const days = Math.min(Math.max(opts.days || 30, 1), 365);
  const limit = Math.min(Math.max(opts.limit || 25, 1), 60);
  const since = new Date(Date.now() - days * 86400000);

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: creds,
    logger: false,
  });
  client.on("error", (e: unknown) => console.error("imap error", String(e)));
  const out: MailHit[] = [];
  await client.connect();
  // Gmail keeps archived and labeled mail out of INBOX; "[Gmail]/All Mail"
  // (special-use \All) is the only folder that has everything. Search there
  // when it exists, and use Gmail's own query syntax when the server offers it
  // (X-GM-EXT-1) so from:/subject:/label:/has:attachment all work as typed.
  const boxes = await client.list();
  const all = boxes.find((b) => b.specialUse === "\\All")?.path;
  const gmail = client.capabilities.has("X-GM-EXT-1");
  const lock = await client.getMailboxLock(all || "INBOX");
  try {
    const q = opts.query?.trim() || "";
    const criteria: Record<string, unknown> = gmail ? { gmraw: `newer_than:${days}d -in:spam -in:trash ${q ? `(${q})` : ""} ${opts.exclude || ""}`.trim() } : { since };
    if (!gmail && q) criteria.text = q;
    const uids = ((await client.search(criteria as any, { uid: true })) || []).slice(-limit).reverse();
    const wantSnippet = uids.length <= 15;
    for (const uid of uids) {
      const msg = await client.fetchOne(uid, wantSnippet ? { envelope: true, source: true } : { envelope: true }, { uid: true });
      if (!msg) continue;
      let snippet = "";
      if (wantSnippet && msg.source) {
        // bodyOf, not parsed.text: forwards from Outlook and many work accounts are HTML-only, and
        // their plain text came back empty (a parent's forward once reached Kimi as just its subject).
        const parsed = await simpleParser(msg.source);
        snippet = bodyOf(parsed).text.replace(/\s+/g, " ").trim().slice(0, 300);
      }
      const env = msg.envelope;
      out.push({
        date: env?.date ? new Date(env.date).toISOString() : "",
        from: env?.from?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address || "")).join(", ") || "",
        subject: env?.subject || "",
        snippet,
        account,
        id: `${account}:${uid}`,
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

export interface RecentMessage extends RawMessage {
  uidValidity: number;
}

/**
 * Everything that arrived in a parent's Gmail in the last `days` days (All
 * Mail, so archived and labeled mail counts), minus what `seen` says we've
 * already looked at (one batched lookup per mailbox). Read-only: never marks anything.
 */
export async function fetchRecent(
  account: MailAccount,
  opts: { days: number; seen: (uidValidity: number, uids: number[]) => Promise<Set<number>>; max?: number; /** extra Gmail search terms */ query?: string }
): Promise<RecentMessage[]> {
  const creds = accountCreds(account);
  if (!creds) throw new Error(`${account}'s Gmail isn't connected`);
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: creds,
    logger: false,
  });
  client.on("error", (e: unknown) => console.error("imap error", String(e)));
  const out: RecentMessage[] = [];
  await client.connect();
  const boxes = await client.list();
  const all = boxes.find((b) => b.specialUse === "\\All")?.path || "INBOX";
  const gmail = client.capabilities.has("X-GM-EXT-1");
  const lock = await client.getMailboxLock(all);
  try {
    const uidValidity = Number(client.mailbox && typeof client.mailbox === "object" ? client.mailbox.uidValidity : 0);
    // Received mail only: what the parent SENT (forwards, invitations) is either
    // already handled or noise.
    const criteria = gmail ? { gmraw: `newer_than:${opts.days}d -in:spam -in:trash -in:sent -from:me ${opts.query || ""}`.trim() } : { since: new Date(Date.now() - opts.days * 86400000) };
    const uids = ((await client.search(criteria as any, { uid: true })) || []).slice(-(opts.max || 200));
    const already = uids.length ? await opts.seen(uidValidity, uids) : new Set<number>();
    for (const uid of uids) {
      if (already.has(uid)) continue;
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const body = bodyOf(parsed);
      out.push({
        uid,
        uidValidity,
        date: parsed.date?.toISOString() ?? new Date().toISOString(),
        from: parsed.from?.text ?? "",
        subject: parsed.subject ?? "",
        text: body.text,
        links: body.links,
        attachments: extractAttachments(parsed),
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

// Mark specific UIDs as \Seen (called after they're successfully processed).
export async function markSeen(uids: number[]): Promise<void> {
  if (!uids.length) return;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!user || !pass) throw new Error("Missing IMAP_USER/IMAP_PASS");
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  client.on("error", (e: unknown) => console.error("imap error", String(e)));
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    await client.messageFlagsAdd(uids.join(","), ["\\Seen"], { uid: true });
  } finally {
    lock.release();
    await client.logout();
  }
}

/** One email in full (body as text, links, attachment names) by its search id. Read-only. */
export async function readMail(account: MailAccount, uid: number): Promise<MailMessage | null> {
  const creds = accountCreds(account);
  if (!creds) throw new Error(`${account} inbox isn't configured`);
  const client = new ImapFlow({ host: process.env.IMAP_HOST || "imap.gmail.com", port: Number(process.env.IMAP_PORT || 993), secure: true, auth: creds, logger: false });
  client.on("error", (e: unknown) => console.error("imap error", String(e)));
  await client.connect();
  const boxes = await client.list();
  const lock = await client.getMailboxLock(boxes.find((b) => b.specialUse === "\\All")?.path || "INBOX");
  try {
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    return messageOf(await simpleParser(msg.source));
  } finally {
    lock.release();
    await client.logout();
  }
}

/** A parsed email as read_email shows it. */
export function messageOf(parsed: Awaited<ReturnType<typeof simpleParser>>): MailMessage {
  const body = bodyOf(parsed);
  const to = Array.isArray(parsed.to) ? parsed.to.map((a) => a.text).join(", ") : parsed.to?.text || "";
  return {
    date: parsed.date?.toISOString() ?? "",
    from: parsed.from?.text ?? "",
    to,
    subject: parsed.subject ?? "",
    text: body.text,
    links: body.links,
    attachments: (parsed.attachments || []).map((a) => `${a.filename || "(unnamed)"} (${a.contentType})`),
  };
}

