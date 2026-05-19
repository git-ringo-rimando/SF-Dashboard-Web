import { NextRequest, NextResponse } from "next/server";
import { loadCache, type RecentTicket, type TicketRow } from "@/lib/store";

const BASE = "https://sfsupport.dataon.com";

export async function GET(req: NextRequest) {
  const ticketNo = req.nextUrl.searchParams.get("ticketNo")?.trim();
  if (!ticketNo) return NextResponse.json({ error: "ticketNo required" }, { status: 400 });

  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({ cached: null });

  const cache = await loadCache(username);
  if (!cache) return NextResponse.json({ cached: null });

  const inRecent      = cache.recentTickets.find((t) => t.ticketNo === ticketNo) ?? null;
  const inUnresolved  = cache.unresolvedTickets.find((t) => t.documentNo === ticketNo) ?? null;
  const inUnresponded = cache.unrespondedTickets.find((t) => t.documentNo === ticketNo) ?? null;

  return NextResponse.json({ cached: inRecent ?? inUnresolved ?? inUnresponded ?? null });
}

export async function POST(req: NextRequest) {
  const { ticketNo } = await req.json().catch(() => ({}));
  if (!ticketNo) return NextResponse.json({ error: "ticketNo required" }, { status: 400 });

  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const cache = await loadCache(username);
  if (!cache) return NextResponse.json({ error: "No cached data." }, { status: 404 });

  // Find ticket in cache — prefer recentTickets (richer fields) over summary tables
  const recent = cache.recentTickets.find((t) => t.ticketNo === ticketNo);
  const summary =
    cache.unresolvedTickets.find((t) => t.documentNo === ticketNo) ??
    cache.unrespondedTickets.find((t) => t.documentNo === ticketNo);

  if (!recent && !summary) {
    return NextResponse.json({ error: `Ticket ${ticketNo} not found.` }, { status: 404 });
  }

  let fields: Record<string, string>;

  if (recent) {
    const t = recent as RecentTicket;
    fields = {
      "Document No":   t.ticketNo,
      "Subject":       t.subject,
      "Project":       t.project,
      "Module":        t.module,
      "Type":          t.task,
      "Status":        t.status,
      "Severity":      t.severity,
      "Reported Date": t.reportedDate,
      "Created Date":  t.createdDate,
      "Fixed Date":    t.fixedDate,
      "Completion":    t.completion,
    };
  } else {
    const t = summary as TicketRow;
    fields = {
      "Document No":   t.documentNo,
      "Project":       t.project,
      "Type":          t.type,
      "Status":        t.status,
      "Reported Date": t.reportedDate,
    };
  }

  // Strip empty values so the modal doesn't show blank rows
  for (const k of Object.keys(fields)) {
    if (!fields[k]) delete fields[k];
  }

  return NextResponse.json({
    fields,
    url: `${BASE}/app/ticket/forms/${ticketNo}`,
  });
}
