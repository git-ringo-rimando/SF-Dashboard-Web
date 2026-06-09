// Builds the HTML body + subject for the dashboard summary email.
//
// The email is rendered from a normalized SummaryData payload. The client sends
// this built from its *currently filtered* view (so the email matches exactly
// what's on screen — e.g. "SDP Today"). The cron path builds it from the raw
// cache via cacheToSummaryData().

import type { DashboardCache, SeverityRow, ModuleRow } from "./store";

// Always-included recipients for every summary email (manual + scheduled).
// The logged-in user is added on top of these at send time.
export const PERMANENT_RECIPIENTS = ["sdpopslead@dataon.ph", "s.coles@dataon.ph"];

/** Merge permanent recipients + the logged-in user into the custom list, deduped. */
export function withPermanentRecipients(custom: string[], userEmail?: string | null): string[] {
  const all = [...PERMANENT_RECIPIENTS];
  if (userEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail.trim())) all.push(userEmail.trim());
  for (const r of custom) all.push(r);
  const seen = new Set<string>();
  return all.filter((e) => {
    const k = e.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── .eml generation (works in Node 18+ and the browser — both have btoa/TextEncoder) ──

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Build an .eml (RFC 822) message. The `X-Unsent: 1` header makes Outlook open
 * it as an editable, ready-to-send draft rather than a read-only message.
 */
export function buildSummaryEml(opts: { from: string | null; to: string[]; subject: string; html: string }): string {
  const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
  const headers = [
    "X-Unsent: 1",
    ...(opts.from ? [`From: ${opts.from}`] : []),
    `To: ${opts.to.join(", ")}`,
    `Subject: =?UTF-8?B?${utf8ToBase64(opts.subject)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].join("\r\n");
  return `${headers}\r\n\r\n${wrap76(utf8ToBase64(opts.html))}`;
}

export interface SummaryTotals {
  all: number;
  open: number;
  responded: number;
  reopen: number;
  fixed: number;
  closed: number;
  cancelled: number;
  unresolved: number;
  unresponded: number;
}

export interface SummaryTicket {
  ticketNo: string;
  project: string;
  subject: string;
  severity: string;
  status: string;
}

export interface SummaryData {
  scrapedAt: string;
  filterLabel: string;        // e.g. "SDP Today" or "All data"
  coverage?: string;          // human date-range coverage, if any
  statisticPeriod?: string;
  error?: string | null;
  totals: SummaryTotals;
  severityBreakdown: SeverityRow[];
  moduleBreakdown: ModuleRow[];
  recentTickets: SummaryTicket[];
}

// ── Mapping / validation ───────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Full (unfiltered) snapshot from a cache — used by the scheduled cron. */
export function cacheToSummaryData(cache: DashboardCache): SummaryData {
  return {
    scrapedAt: cache.scrapedAt,
    filterLabel: "All data",
    statisticPeriod: cache.statisticPeriod,
    error: cache.error,
    totals: {
      all: cache.totals.all,
      open: cache.totals.open,
      responded: cache.totals.responded,
      reopen: cache.totals.reopen,
      fixed: cache.totals.fixed,
      closed: cache.totals.closed,
      cancelled: cache.totals.cancelled,
      unresolved: cache.totals.unresolved,
      unresponded: cache.totals.unresponded,
    },
    severityBreakdown: cache.severityBreakdown,
    moduleBreakdown: cache.moduleBreakdown,
    recentTickets: cache.recentTickets.map((t) => ({
      ticketNo: t.ticketNo, project: t.project, subject: t.subject,
      severity: t.severity, status: t.status,
    })),
  };
}

/** Coerce an untrusted client payload into a safe SummaryData. */
export function coerceSummaryData(input: unknown): SummaryData | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const t = (o.totals ?? {}) as Record<string, unknown>;
  const sev = Array.isArray(o.severityBreakdown) ? o.severityBreakdown : [];
  const mod = Array.isArray(o.moduleBreakdown) ? o.moduleBreakdown : [];
  const recent = Array.isArray(o.recentTickets) ? o.recentTickets : [];

  return {
    scrapedAt: str(o.scrapedAt),
    filterLabel: str(o.filterLabel) || "Filtered",
    coverage: o.coverage ? str(o.coverage) : undefined,
    statisticPeriod: o.statisticPeriod ? str(o.statisticPeriod) : undefined,
    error: o.error ? str(o.error) : null,
    totals: {
      all: num(t.all), open: num(t.open), responded: num(t.responded),
      reopen: num(t.reopen), fixed: num(t.fixed), closed: num(t.closed),
      cancelled: num(t.cancelled), unresolved: num(t.unresolved), unresponded: num(t.unresponded),
    },
    severityBreakdown: sev.slice(0, 20).map((r) => {
      const x = r as Record<string, unknown>;
      return {
        severity: str(x.severity), open: num(x.open), responded: num(x.responded),
        reopen: num(x.reopen), fixed: num(x.fixed), closed: num(x.closed), cancelled: num(x.cancelled),
      };
    }),
    moduleBreakdown: mod.slice(0, 50).map((r) => {
      const x = r as Record<string, unknown>;
      return {
        module: str(x.module), total: num(x.total),
        critical: num(x.critical), high: num(x.high), medium: num(x.medium), low: num(x.low),
        open: num(x.open), responded: num(x.responded), reopen: num(x.reopen),
        fixed: num(x.fixed), closed: num(x.closed), cancelled: num(x.cancelled),
      };
    }),
    recentTickets: recent.slice(0, 30).map((r) => {
      const x = r as Record<string, unknown>;
      return {
        ticketNo: str(x.ticketNo), project: str(x.project), subject: str(x.subject),
        severity: str(x.severity), status: str(x.status),
      };
    }),
  };
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function summarySubject(data: SummaryData, username: string | null): string {
  const t = data.totals;
  const who = username ? ` — ${username}` : "";
  const scope = data.filterLabel ? ` (${data.filterLabel})` : "";
  // Prefer the filter's date coverage; fall back to ticket counts when none.
  const detail = data.coverage || `${t.open} open, ${t.unresolved} unresolved`;
  return `SF Dashboard Summary${who}${scope}: ${detail}`;
}

const STAT_CARDS: { key: keyof SummaryTotals; label: string; color: string }[] = [
  { key: "all",         label: "Total",       color: "#0f766e" },
  { key: "open",        label: "Open",        color: "#dc2626" },
  { key: "responded",   label: "Responded",   color: "#ca8a04" },
  { key: "reopen",      label: "Reopen",      color: "#ea580c" },
  { key: "fixed",       label: "Fixed",       color: "#2563eb" },
  { key: "closed",      label: "Closed",      color: "#16a34a" },
  { key: "unresolved",  label: "Unresolved",  color: "#b91c1c" },
  { key: "unresponded", label: "Unresponded", color: "#9333ea" },
];

const STATUS_COLS: { key: keyof SeverityRow; label: string }[] = [
  { key: "open",      label: "Open" },
  { key: "responded", label: "Responded" },
  { key: "reopen",    label: "Reopen" },
  { key: "fixed",     label: "Fixed" },
  { key: "closed",    label: "Closed" },
  { key: "cancelled", label: "Cancelled" },
];

function statCardsHtml(data: SummaryData): string {
  const cells = STAT_CARDS.map((c) => `
    <td style="padding:6px;" width="12.5%">
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 8px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:${c.color};line-height:1;">${data.totals[c.key] ?? 0}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.04em;">${c.label}</div>
      </div>
    </td>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tr>${cells}</tr></table>`;
}

function breakdownTableHtml(
  title: string,
  rows: Record<string, string | number>[],
  firstKey: string,
  firstLabel: string,
): string {
  if (!rows.length) return "";
  const head = `
    <tr style="background:#f9fafb;">
      <th align="left" style="padding:8px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;">${esc(firstLabel)}</th>
      ${STATUS_COLS.map((c) => `<th align="right" style="padding:8px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;">${c.label}</th>`).join("")}
    </tr>`;
  const body = rows.map((r) => `
    <tr>
      <td style="padding:8px 10px;font-size:13px;color:#111827;border-bottom:1px solid #f3f4f6;">${esc(String(r[firstKey]))}</td>
      ${STATUS_COLS.map((c) => `<td align="right" style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${r[c.key] ?? 0}</td>`).join("")}
    </tr>`).join("");
  return `
    <h3 style="font-size:14px;color:#111827;margin:24px 0 8px;">${esc(title)}</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;overflow:hidden;">
      ${head}${body}
    </table>`;
}

function recentTicketsHtml(data: SummaryData, limit = 10): string {
  const rows = data.recentTickets.slice(0, limit);
  if (!rows.length) return "";
  const body = rows.map((t) => `
    <tr>
      <td style="padding:8px 10px;font-size:12px;color:#0f766e;font-weight:600;border-bottom:1px solid #f3f4f6;white-space:nowrap;">${esc(t.ticketNo)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;border-bottom:1px solid #f3f4f6;">${esc(t.project)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;border-bottom:1px solid #f3f4f6;">${esc(t.subject)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;border-bottom:1px solid #f3f4f6;white-space:nowrap;">${esc(t.severity)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;border-bottom:1px solid #f3f4f6;white-space:nowrap;">${esc(t.status)}</td>
    </tr>`).join("");
  return `
    <h3 style="font-size:14px;color:#111827;margin:24px 0 8px;">Recent tickets (${rows.length})</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;overflow:hidden;">
      <tr style="background:#f9fafb;">
        <th align="left" style="padding:8px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;">Ticket</th>
        <th align="left" style="padding:8px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;">Project</th>
        <th align="left" style="padding:8px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;">Subject</th>
        <th align="left" style="padding:8px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;">Severity</th>
        <th align="left" style="padding:8px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;">Status</th>
      </tr>
      ${body}
    </table>`;
}

export function renderSummaryHtml(data: SummaryData, username: string | null): string {
  const topModules = [...data.moduleBreakdown]
    .sort((a, b) => b.total - a.total)
    .slice(0, 12) as unknown as Record<string, string | number>[];
  const severityRows = data.severityBreakdown as unknown as Record<string, string | number>[];
  const coverage = data.coverage ? ` • ${esc(data.coverage)}` : "";

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#0f766e;padding:20px 24px;">
            <div style="color:#ffffff;font-size:18px;font-weight:700;">SF Dashboard Summary</div>
            <div style="color:#5eead4;font-size:13px;font-weight:600;margin-top:6px;">${esc(data.filterLabel)}</div>
            <div style="color:#99f6e4;font-size:12px;margin-top:4px;">
              ${username ? esc(username) + " • " : ""}Snapshot from ${fmtDateTime(data.scrapedAt)}${coverage}
            </div>
          </td>
        </tr>
        <tr><td style="padding:20px 24px;">
          ${data.error ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:12px;padding:10px 12px;border-radius:8px;margin-bottom:16px;">Last scrape reported an error: ${esc(data.error)}</div>` : ""}
          ${statCardsHtml(data)}
          ${breakdownTableHtml("By severity", severityRows, "severity", "Severity")}
          ${breakdownTableHtml("Top modules", topModules, "module", "Module")}
          ${recentTicketsHtml(data)}
          <p style="font-size:11px;color:#9ca3af;margin:24px 0 0;">
            Filtered view: <strong>${esc(data.filterLabel)}</strong>${data.statisticPeriod ? ` · Statistic period: ${esc(data.statisticPeriod)}` : ""}. Automated summary from SF Dashboard.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
