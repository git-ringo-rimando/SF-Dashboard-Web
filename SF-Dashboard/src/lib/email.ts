// SMTP email sender (Nodemailer) — works with any standard mail server,
// including Zimbra.
//
// Uses a fixed service account (MAILER-DAEMON) to send all emails.
// The authenticating account is shared, not per-user.
//
// Required:
//   SMTP_HOST   — mail server hostname (e.g. mail.dataon.ph)
//   SMTP_USER   — daemon account username (e.g. mailer-daemon)
//   SMTP_PASS   — daemon account password
//   SMTP_FROM   — sender email address (e.g. MAILER-DAEMON@mail.dataon.com)
// Optional:
//   SMTP_PORT       — default 587 (STARTTLS). Use 465 for implicit SSL.
//   SMTP_SECURE     — "true" forces SSL; defaults to true when port is 465, else false.
//   SMTP_TLS_SERVERNAME       — name to validate the TLS cert against.
//   SMTP_TLS_REJECT_UNAUTHORIZED — "false" to skip cert validation (last resort).

import nodemailer from "nodemailer";

const HOST = process.env.SMTP_HOST;
const ENV_USER = process.env.SMTP_USER;
const ENV_PASS = process.env.SMTP_PASS;
const PORT = Number(process.env.SMTP_PORT ?? 587);
const SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === "true"
  : PORT === 465;
const ENV_FROM = process.env.SMTP_FROM;
const TLS_SERVERNAME = process.env.SMTP_TLS_SERVERNAME;
const TLS_REJECT_UNAUTHORIZED = process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false";

/** The mail server itself is configured (host present). */
export function emailConfigured(): boolean {
  return !!HOST;
}

export interface MailAuth {
  user: string;
  pass: string;
}

export async function sendMail(opts: {
  to: string[];
  subject: string;
  html: string;
  cc?: string[];
}): Promise<void> {
  if (!emailConfigured()) {
    throw new Error("Email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM.");
  }

  if (!ENV_USER || !ENV_PASS || !ENV_FROM) {
    throw new Error("Email credentials incomplete. Set SMTP_USER, SMTP_PASS, and SMTP_FROM.");
  }

  const to = opts.to.map((a) => a.trim()).filter(Boolean);
  if (!to.length) throw new Error("No recipients provided.");

  const transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: { user: ENV_USER, pass: ENV_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: {
      rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
      ...(TLS_SERVERNAME ? { servername: TLS_SERVERNAME } : {}),
    },
  });

  await transporter.sendMail({
    from: ENV_FROM,
    to,
    cc: (opts.cc ?? []).map((a) => a.trim()).filter(Boolean),
    subject: opts.subject,
    html: opts.html,
  });
}
