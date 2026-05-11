import { NextRequest, NextResponse } from "next/server";
import { loadCredentials } from "@/lib/store";
import { scrape } from "@/lib/scraper";

export async function POST(req: NextRequest) {
  const creds = loadCredentials();
  if (!creds) {
    return NextResponse.json({ error: "No credentials saved." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const targetDateFrom: string | undefined = body.targetDateFrom;
  scrape(creds.username, creds.password, targetDateFrom).catch(console.error);
  return NextResponse.json({ ok: true, message: "Scrape started." });
}
