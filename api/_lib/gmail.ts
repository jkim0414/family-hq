import { google } from "googleapis";
import { redis } from "./db.js";
import type { MailHit } from "./imap.js";

// Each parent's own Gmail, connected via Google sign-in (read-only scope). The
// refresh token is stored per parent; nothing is stored about the mail itself.
// Search only — Kimi never sends from, labels, or deletes in these inboxes.

export interface GmailConn {
  refreshToken: string;
  email: string;
  connectedAt: string;
}

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/userinfo.email"];

const key = (userId: string) => `gmail_token:${userId}`;

export async function getGmailConn(userId: string): Promise<GmailConn | null> {
  return (await redis.get<GmailConn>(key(userId))) ?? null;
}

export async function gmailConnected(userId: string): Promise<boolean> {
  return !!(await getGmailConn(userId));
}

export async function saveGmailConn(userId: string, conn: GmailConn): Promise<void> {
  await redis.set(key(userId), conn);
}

export async function disconnectGmail(userId: string): Promise<void> {
  const conn = await getGmailConn(userId);
  if (conn) {
    // Best-effort revoke so the grant disappears from the Google account page too.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(conn.refreshToken)}`, { method: "POST" }).catch(() => {});
  }
  await redis.del(key(userId));
}

function client(conn: GmailConn) {
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: conn.refreshToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}

const header = (headers: { name?: string | null; value?: string | null }[] | undefined, name: string) =>
  headers?.find((h) => (h.name || "").toLowerCase() === name.toLowerCase())?.value || "";

/** Newest-first matches in the parent's inbox; Gmail search syntax works in `query`. */
export async function searchGmail(userId: string, opts: { query?: string; days?: number; limit?: number }): Promise<MailHit[]> {
  const conn = await getGmailConn(userId);
  if (!conn) throw new Error(`${userId}'s Gmail isn't connected`);
  const days = Math.min(Math.max(opts.days || 30, 1), 365);
  const limit = Math.min(Math.max(opts.limit || 25, 1), 60);
  const gmail = client(conn);
  const q = [`newer_than:${days}d`, "-in:spam", "-in:trash", opts.query?.trim() || ""].filter(Boolean).join(" ");
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: limit });
  const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
  const msgs = await Promise.all(
    ids.map((id) =>
      gmail.users.messages
        .get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] })
        .then((r) => r.data)
        .catch(() => null)
    )
  );
  return msgs
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => {
      const h = m.payload?.headers || undefined;
      const ms = Number(m.internalDate || 0);
      return {
        date: ms ? new Date(ms).toISOString() : header(h, "Date"),
        from: header(h, "From"),
        subject: header(h, "Subject") || "(no subject)",
        snippet: (m.snippet || "").trim(),
        account: userId as MailHit["account"],
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
