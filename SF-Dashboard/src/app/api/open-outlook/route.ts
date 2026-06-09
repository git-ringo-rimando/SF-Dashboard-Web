import { NextRequest, NextResponse } from "next/server";
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { loadCache, loadCredentials } from "@/lib/store";
import {
  renderSummaryHtml, summarySubject, cacheToSummaryData, coerceSummaryData,
  withPermanentRecipients, buildSummaryEml,
} from "@/lib/summary";

// Opens the summary as a draft in the desktop Outlook running on the SAME machine
// as this server. Only works when the app runs on a Windows host with Outlook
// (i.e. a local/on-prem run) — on other hosts it returns 503 so the client can
// fall back to downloading the .eml.
export async function POST(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  if (process.platform !== "win32") {
    return NextResponse.json(
      { error: "Direct Outlook open is only available when the app runs on a Windows machine with Outlook." },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({})) as { recipients?: string[]; summary?: unknown };

  const custom = (body.recipients ?? []).map((r) => r.trim()).filter(Boolean);
  const creds = await loadCredentials(username);
  const displayName = creds?.username ?? username;
  const to = withPermanentRecipients(custom, displayName);

  let summary = coerceSummaryData(body.summary);
  if (!summary) {
    const cache = await loadCache(username);
    if (!cache) return NextResponse.json({ error: "No dashboard data yet — refresh first." }, { status: 400 });
    summary = cacheToSummaryData(cache);
  }

  const eml = buildSummaryEml({
    from: displayName,
    to,
    subject: summarySubject(summary, displayName),
    html: renderSummaryHtml(summary, displayName),
  });

  // Write to a temp .eml and open it with the default handler (Outlook).
  const file = path.join(os.tmpdir(), `sf-summary-${Date.now()}.eml`);
  try {
    fs.writeFileSync(file, eml, "utf8");
    // `start "" "<file>"` opens the file with its associated app, detached.
    const child = spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[open-outlook]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
