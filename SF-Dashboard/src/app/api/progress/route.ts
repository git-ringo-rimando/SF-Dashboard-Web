import { NextResponse } from "next/server";
import { loadProgress } from "@/lib/store";

export async function GET() {
  const progress = await loadProgress();
  return NextResponse.json(progress, { headers: { "Cache-Control": "no-store" } });
}
