import { NextRequest, NextResponse } from "next/server";
import { saveCredentials, loadCredentials, clearAllData } from "@/lib/store";
import { verifyLogin, scrape } from "@/lib/scraper";

const COOKIE = "sf_user";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 30 * 24 * 60 * 60, // 30 days
};

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  let result: { ok: true; cookies: import("puppeteer").Cookie[] } | { ok: false; error: string };
  try {
    result = await verifyLogin(username, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[auth] verifyLogin threw:", msg);
    const friendly = /timeout|ECONNREFUSED|net::ERR/i.test(msg)
      ? "Could not reach sfsupport.dataon.com — check your connection and try again."
      : "An unexpected error occurred while verifying your credentials.";
    return NextResponse.json({ error: friendly }, { status: 502 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  await saveCredentials(username, password);
  scrape(username, password, undefined, result.cookies).catch(console.error);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, username, COOKIE_OPTS);
  return res;
}

export async function GET(req: NextRequest) {
  const username = req.cookies.get(COOKIE)?.value ?? null;
  if (!username) return NextResponse.json({ hasCredentials: false, username: null });
  const creds = await loadCredentials(username);
  return NextResponse.json({ hasCredentials: !!creds, username: creds?.username ?? null });
}

export async function DELETE(req: NextRequest) {
  const username = req.cookies.get(COOKIE)?.value;
  if (username) await clearAllData(username);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
  return res;
}
