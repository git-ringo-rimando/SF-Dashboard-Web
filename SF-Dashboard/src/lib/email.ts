// SMTP email sender (Nodemailer) — works with any standard mail server,
// including Zimbra. Configured entirely through env vars.
//
// Required:
//   SMTP_HOST   — mail server hostname (e.g. mail.yourcompany.com)
//   SMTP_USER   — login username (usually the full email address)
//   SMTP_PASS   — login password
// Optional:
//   SMTP_PORT       — default 587 (STARTTLS). Use 465 for implicit SSL.
//   SMTP_SECURE     — "true" forces SSL; defaults to true when port is 465, else false.
//   SMTP_FROM       — "From" address; defaults to SMTP_USER.
//   SMTP_TLS_SERVERNAME       — name to validate the TLS cert against (use this when
//                               the host you connect to differs from the cert's name).
//   SMTP_TLS_REJECT_UNAUTHORIZED — "false" to skip cert validation entirely (last resort).

import nodemailer, { type Transporter } from "nodemailer";

const HOST = process.env.SMTP_HOST;
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const PORT = Number(process.env.SMTP_PORT ?? 587);
const SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === "true"
  : PORT === 465;
const FROM = process.env.SMTP_FROM ?? USER;
const TLS_SERVERNAME = process.env.SMTP_TLS_SERVERNAME;
const TLS_REJECT_UNAUTHORIZED = process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false";

export function emailConfigured(): boolean {
  return !!(HOST && USER && PASS);
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: SECURE,
      auth: { user: USER, pass: PASS },
      tls: {
        rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
        ...(TLS_SERVERNAME ? { servername: TLS_SERVERNAME } : {}),
      },
    });
  }
  return transporter;
}

export async function sendMail(opts: {
  to: string[];
  subject: string;
  html: string;
  cc?: string[];
}): Promise<void> {
  if (!emailConfigured()) {
    throw new Error("Email is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS.");
  }
  const to = opts.to.map((a) => a.trim()).filter(Boolean);
  if (!to.length) throw new Error("No recipients provided.");

  await getTransporter().sendMail({
    from: FROM,
    to,
    cc: (opts.cc ?? []).map((a) => a.trim()).filter(Boolean),
    subject: opts.subject,
    html: opts.html,
  });
}
