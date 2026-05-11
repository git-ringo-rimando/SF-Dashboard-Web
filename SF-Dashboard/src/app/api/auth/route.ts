import { NextRequest, NextResponse } from "next/server";
import { saveCredentials, loadCredentials, clearAllData } from "@/lib/store";
import { verifyLogin, scrape } from "@/lib/scraper";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  // Verify the credentials actually work before saving them
  let result: { ok: true } | { ok: false; error: string };
  try {
    result = await verifyLogin(username, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = /timeout|ECONNREFUSED|net::ERR/i.test(msg)
      ? "Could not reach sfsupport.dataon.com — check your connection and try again."
      : "An unexpected error occurred while verifying your credentials.";
    return NextResponse.json({ error: friendly }, { status: 502 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  // Login confirmed — save and kick off a full background scrape
  await saveCredentials(username, password);
  scrape(username, password).catch(console.error);

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const creds = await loadCredentials();
  return NextResponse.json({ hasCredentials: !!creds, username: creds?.username ?? null });
}

export async function DELETE() {
  await clearAllData();
  return NextResponse.json({ ok: true });
}
