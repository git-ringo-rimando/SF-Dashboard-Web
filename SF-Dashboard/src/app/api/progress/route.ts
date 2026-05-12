import { NextRequest, NextResponse } from "next/server";
import { loadProgress } from "@/lib/store";

export async function GET(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json(null, { headers: { "Cache-Control": "no-store" } });
  const progress = await loadProgress(username);
  return NextResponse.json(progress, { headers: { "Cache-Control": "no-store" } });
}
