// SMTP email sender (Nodemailer) — works with any standard mail server,
// including Zimbra.
//
// Each email is sent from the logged-in user's mailbox using their Zimbra password.
// If no user password is available, falls back to fixed credentials (if set).
//
// Required:
//   SMTP_HOST   — mail server hostname (e.g. mail.dataon.ph)
// Optional (defaults to logged-in user):
//   SMTP_USER   — fallback sender account username (if user has no password)
//   SMTP_PASS   — fallback sender account password (if user has no password)
//   SMTP_FROM   — fallback sender email (if user has no password, defaults to SMTP_USER)
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
  smtpUser?: string;
  smtpPass?: string;
  from?: string;
}): Promise<void> {
  if (!emailConfigured()) {
    throw new Error("Email is not configured. Set SMTP_HOST.");
  }

  const smtpUser = opts.smtpUser || ENV_USER;
  const smtpPass = opts.smtpPass || ENV_PASS;
  const from = opts.from || ENV_FROM;

  if (!smtpUser || !smtpPass || !from) {
    throw new Error("Email credentials incomplete. Provide SMTP_USER, SMTP_PASS, and SMTP_FROM (or set environment variables).");
  }

  const to = opts.to.map((a) => a.trim()).filter(Boolean);
  if (!to.length) throw new Error("No recipients provided.");

  const transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: { user: smtpUser, pass: smtpPass },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: {
      rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
      ...(TLS_SERVERNAME ? { servername: TLS_SERVERNAME } : {}),
    },
  });

  await transporter.sendMail({
    from,
    to,
    cc: (opts.cc ?? []).map((a) => a.trim()).filter(Boolean),
    subject: opts.subject,
    html: opts.html,
  });
}
