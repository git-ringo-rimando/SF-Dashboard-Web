import { NextRequest, NextResponse } from "next/server";
import { saveCredentials, hasCredentials, loadCredentials } from "@/lib/store";
import { verifyLogin, scrape } from "@/lib/scraper";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  // Verify the credentials actually work before saving them
  const result = await verifyLogin(username, password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  // Login confirmed — save and kick off a full background scrape
  saveCredentials(username, password);
  scrape(username, password).catch(console.error);

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const creds = loadCredentials();
  return NextResponse.json({ hasCredentials: !!creds, username: creds?.username ?? null });
}

export async function DELETE() {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
    for (const file of ["credentials.enc", "cache.json", "tags.json"]) {
      const p = path.join(DATA_DIR, file);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}
  return NextResponse.json({ ok: true });
}
