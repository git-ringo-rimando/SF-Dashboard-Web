import { NextRequest, NextResponse } from "next/server";
import { loadSummarySettings, saveSummarySettings, type SummarySettings } from "@/lib/store";
import { emailConfigured } from "@/lib/email";

export async function GET(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const settings = await loadSummarySettings(username);
  return NextResponse.json(
    { settings, emailConfigured: emailConfigured() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const body = await req.json() as Partial<SummarySettings>;
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const invalid = recipients.find((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.trim()));
  if (invalid) {
    return NextResponse.json({ error: `Invalid email address: ${invalid}` }, { status: 400 });
  }

  await saveSummarySettings(username, {
    recipients,
    scheduleEnabled: !!body.scheduleEnabled,
  });
  return NextResponse.json({ ok: true });
}
