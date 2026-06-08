// SMTP email sender (Nodemailer) — works with any standard mail server,
// including Zimbra.
//
// The mail server connection is configured via env vars, but the *authenticating
// account* is per-user: each logged-in user sends from their own Zimbra mailbox
// using the username they logged in with + the Zimbra password they provided.
// If no per-user auth is passed, it falls back to the SMTP_USER/SMTP_PASS env vars.
//
// Required:
//   SMTP_HOST   — mail server hostname (e.g. mail.dataon.ph)
// Per-user (preferred) — passed to sendMail({ auth }); otherwise from env:
//   SMTP_USER   — fallback login username
//   SMTP_PASS   — fallback login password
// Optional:
//   SMTP_PORT       — default 587 (STARTTLS). Use 465 for implicit SSL.
//   SMTP_SECURE     — "true" forces SSL; defaults to true when port is 465, else false.
//   SMTP_FROM       — fallback "From" address; defaults to the auth user.
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
  auth?: MailAuth;        // per-user SMTP credentials (preferred)
}): Promise<void> {
  if (!emailConfigured()) {
    throw new Error("Email is not configured. Set SMTP_HOST (and per-user or SMTP_USER/SMTP_PASS).");
  }

  const user = opts.auth?.user || ENV_USER;
  const pass = opts.auth?.pass || ENV_PASS;
  if (!user || !pass) {
    throw new Error("No mailbox credentials. Sign in again and enter your Zimbra email password to send.");
  }

  const to = opts.to.map((a) => a.trim()).filter(Boolean);
  if (!to.length) throw new Error("No recipients provided.");

  // A fresh transporter per send — credentials differ per user.
  const transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: { user, pass },
    // Fail fast instead of hanging when the mail server is unreachable
    // (e.g. an internal server not reachable from the hosting network).
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: {
      rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
      ...(TLS_SERVERNAME ? { servername: TLS_SERVERNAME } : {}),
    },
  });

  await transporter.sendMail({
    from: user || ENV_FROM,   // send from the authenticating mailbox
    to,
    cc: (opts.cc ?? []).map((a) => a.trim()).filter(Boolean),
    subject: opts.subject,
    html: opts.html,
  });
}
