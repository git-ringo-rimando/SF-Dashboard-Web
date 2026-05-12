import { NextRequest, NextResponse } from "next/server";
import { loadCredentials, loadCache, loadTags } from "@/lib/store";

export async function GET(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value ?? null;
  if (!username) return NextResponse.json({ hasCreds: false, cache: null, username: null, tags: {} });

  const creds = await loadCredentials(username);
  const hasCreds = !!creds;
  const [cache, tags] = hasCreds
    ? await Promise.all([loadCache(username), loadTags(username)])
    : [null, {}];

  return NextResponse.json(
    { hasCreds, cache, username: creds?.username ?? null, tags },
    { headers: { "Cache-Control": "no-store" } }
  );
}
