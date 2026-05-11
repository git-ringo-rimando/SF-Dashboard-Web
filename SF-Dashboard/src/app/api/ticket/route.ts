import { NextRequest, NextResponse } from "next/server";
import { loadCredentials, loadCache } from "@/lib/store";
import { scrapeTicketDetail } from "@/lib/scraper";

// GET /api/ticket?ticketNo=TCK... — search the local cache
export async function GET(req: NextRequest) {
  const ticketNo = req.nextUrl.searchParams.get("ticketNo")?.trim();
  if (!ticketNo) return NextResponse.json({ error: "ticketNo required" }, { status: 400 });

  const cache = await loadCache();
  if (!cache) return NextResponse.json({ cached: null });

  const inRecent      = cache.recentTickets.find((t) => t.ticketNo === ticketNo) ?? null;
  const inUnresolved  = cache.unresolvedTickets.find((t) => t.documentNo === ticketNo) ?? null;
  const inUnresponded = cache.unrespondedTickets.find((t) => t.documentNo === ticketNo) ?? null;

  return NextResponse.json({ cached: inRecent ?? inUnresolved ?? inUnresponded ?? null });
}

// POST /api/ticket — scrape the live detail page
export async function POST(req: NextRequest) {
  const { ticketNo } = await req.json().catch(() => ({}));
  if (!ticketNo) return NextResponse.json({ error: "ticketNo required" }, { status: 400 });

  const creds = loadCredentials();
  if (!creds) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const result = await scrapeTicketDetail(creds.username, creds.password, ticketNo);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 404 });

  return NextResponse.json(result);
}
