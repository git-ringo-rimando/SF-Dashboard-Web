import { NextRequest, NextResponse } from "next/server";
import { runScheduledSummaries } from "@/lib/summaryJob";

// HTTP trigger for the daily summary fan-out — handy for manual runs or an
// external scheduler. On Render the in-process node-cron job (instrumentation.ts)
// drives the daily send; this endpoint is an optional extra trigger.
// Protected by CRON_SECRET: send "Authorization: Bearer <CRON_SECRET>".
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const result = await runScheduledSummaries();
  if (!result.ok && result.error) {
    return NextResponse.json(result, { status: 503 });
  }
  return NextResponse.json(result);
}
