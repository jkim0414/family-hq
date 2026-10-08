import { localSkip } from "./sandbox.js";
import nodemailer from "nodemailer";
import { CONFIG } from "../../src/data/config.js";

// Sends from the dedicated school inbox via Gmail SMTP, using the same app
// password as IMAP. No third-party email service needed.
function transport() {
  const user = process.env.SMTP_USER || process.env.IMAP_USER;
  const pass = process.env.SMTP_PASS || process.env.IMAP_PASS;
  if (!user || !pass) throw new Error("Missing SMTP_USER/SMTP_PASS (or IMAP_*)");
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

const RECIPIENTS = [CONFIG.parents.alex.email, CONFIG.parents.sam.email].filter(Boolean);

export async function sendEmail(
  subject: string,
  html: string,
  opts?: { text?: string; to?: string[]; cc?: string[]; replyTo?: string; fromName?: string }
) {
  if (localSkip(`email "${subject.slice(0, 40)}"`)) return;
  const from = `"${opts?.fromName || "Kimi · Family HQ"}" <${process.env.SMTP_USER || process.env.IMAP_USER}>`;
  await transport().sendMail({
    from,
    to: (opts?.to && opts.to.length ? opts.to : RECIPIENTS).join(", "),
    cc: opts?.cc?.length ? opts.cc.join(", ") : undefined,
    replyTo: opts?.replyTo,
    subject,
    text: opts?.text || html.replace(/<[^>]+>/g, ""),
    html,
  });
}
