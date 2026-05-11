import { NextResponse } from "next/server";
import { loadCredentials, loadCache, loadTags } from "@/lib/store";

export async function GET() {
  const creds = loadCredentials();
  const hasCreds = !!creds;
  const [cache, tags] = hasCreds
    ? await Promise.all([loadCache(), loadTags()])
    : [null, {}];
  const username = creds?.username ?? null;
  return NextResponse.json(
    { hasCreds, cache, username, tags },
    { headers: { "Cache-Control": "no-store" } }
  );
}
