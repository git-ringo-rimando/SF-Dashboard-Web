import { NextRequest, NextResponse } from "next/server";
import { loadCredentials } from "@/lib/store";
import { scrape } from "@/lib/scraper";

export async function POST(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const creds = await loadCredentials(username);
  if (!creds) return NextResponse.json({ error: "No credentials saved." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const targetDateFrom: string | undefined = body.targetDateFrom;
  scrape(creds.username, creds.password, targetDateFrom, creds.memberId, creds.token, creds.cookie).catch(console.error);
  return NextResponse.json({ ok: true, message: "Scrape started." });
}
