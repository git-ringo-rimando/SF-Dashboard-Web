import { NextRequest, NextResponse } from "next/server";
import { loadCache, loadCredentials, loadSummarySettings } from "@/lib/store";
import { sendMail, emailConfigured } from "@/lib/email";
import {
  renderSummaryHtml, summarySubject, cacheToSummaryData, coerceSummaryData,
  withPermanentRecipients,
} from "@/lib/summary";

export async function POST(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  if (!emailConfigured()) {
    return NextResponse.json(
      { error: "Email is not configured on the server. Set the SMTP_* environment variables." },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({})) as {
    recipients?: string[];
    summary?: unknown;
  };

  // Custom recipients from the request, falling back to saved settings.
  let custom = (body.recipients ?? []).map((r) => r.trim()).filter(Boolean);
  if (!custom.length) {
    custom = (await loadSummarySettings(username)).recipients;
  }
  const invalidCustom = custom.find((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
  if (invalidCustom) {
    return NextResponse.json({ error: `Invalid email address: ${invalidCustom}` }, { status: 400 });
  }

  // Always include the permanent recipients + the logged-in user (username = email).
  const recipients = withPermanentRecipients(custom, username);
  if (!recipients.length) {
    return NextResponse.json({ error: "No recipients specified." }, { status: 400 });
  }

  // Prefer the client's filtered view (so the email matches the on-screen filter,
  // e.g. "SDP Today"); fall back to the raw cache snapshot if none was sent.
  let summary = coerceSummaryData(body.summary);
  if (!summary) {
    const cache = await loadCache(username);
    if (!cache) {
      return NextResponse.json({ error: "No dashboard data yet — refresh first." }, { status: 400 });
    }
    summary = cacheToSummaryData(cache);
  }

  const creds = await loadCredentials(username);
  const displayName = creds?.username ?? username;

  try {
    await sendMail({
      to: recipients,
      subject: summarySubject(summary, displayName),
      html: renderSummaryHtml(summary, displayName),
      smtpUser: username,
      smtpPass: creds?.zimbraPassword,
      from: username,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[send-summary]", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  return NextResponse.json({ ok: true, sent: recipients.length });
}
