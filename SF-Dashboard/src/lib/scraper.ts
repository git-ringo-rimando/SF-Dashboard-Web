import {
  saveCache,
  saveProgress,
  clearProgress,
  type DashboardCache,
  type TicketRow,
  type ModuleRow,
  type SeverityRow,
  type RecentTicket,
} from "./store";

const BASE = "https://sfsupport.dataon.com";
const API = `${BASE}/api`;

// ── API shapes ─────────────────────────────────────────────────────────────────

interface LoginResponse {
  id: string;
  userId: string;
}

interface RawTicket {
  id?: string | number;
  documentNo?: string;
  planStart?: string | null;
  planEnd?: string | null;
  fixedDate?: string | null;
  verifiedDate?: string | null;
  closedDate?: string | null;
  estimatedManhours?: number;
  completenessPercentage?: number | null;
  subject?: string;
  description?: string;
  reportedDate?: string;
  moduleId?: number;
  createdAt?: string;
  updatedAt?: string;
  projectId?: string;
  remark?: string | null;
  rootCause?: string | null;
  correctiveAction?: string | null;
  isExternal?: boolean;
  project?: { projectName?: string; projectId?: string };
  module?: { description?: string };
  status?: { description?: string };
  type?: { description?: string };
  sla?: { label?: string; description?: string };
  ticketMembers?: Array<{
    member?: {
      memberDetail?: { firstName?: string; middleName?: string; lastName?: string };
    };
  }>;
}

// ── Login ──────────────────────────────────────────────────────────────────────

export async function verifyLogin(
  username: string,
  password: string
): Promise<{ ok: true; memberId: string; token: string; cookie: string } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${API}/Members/login?include=personal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://sfsupport.dataon.com",
        "Referer": "https://sfsupport.dataon.com/",
      },
      body: JSON.stringify({ email: username, password }),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: text || `Login failed (HTTP ${res.status})` };
  }
  let data: LoginResponse;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Unexpected API response format." };
  }
  if (!data.id || !data.userId) {
    return { ok: false, error: "Unexpected API response — missing token or userId." };
  }
  // Capture session cookie so subsequent API calls share the same session
  const cookie = res.headers.get("set-cookie") ?? "";
  return { ok: true, memberId: String(data.userId), token: data.id, cookie };
}

// ── Ticket query ───────────────────────────────────────────────────────────────

const TICKET_FIELDS = [
  "id", "documentNo", "subject", "reportedDate",
  "fixedDate", "verifiedDate", "closedDate", "planEnd",
  "createdAt", "updatedAt", "completenessPercentage",
];

// Only the relations needed to build the dashboard — history/members/attachments
// are intentionally excluded to keep the response small and fast.
const TICKET_INCLUDE = ["sla", "module", "status", "project", "type"];

function buildQuery(
  targetDateFrom?: string,
  whereExtra?: Record<string, unknown>
): string {
  const q: Record<string, unknown> = {
    fields: TICKET_FIELDS,
    include: TICKET_INCLUDE,
    order: "reportedDate desc",
  };
  const where: Record<string, unknown> = { ...(whereExtra ?? {}) };
  if (targetDateFrom) where.reportedDate = { gte: targetDateFrom };
  if (Object.keys(where).length) q.where = where;
  return JSON.stringify(q);
}

async function fetchTickets(
  token: string,
  memberId: string,
  cookie: string,
  targetDateFrom?: string,
  whereExtra?: Record<string, unknown>
): Promise<RawTicket[]> {
  const q = buildQuery(targetDateFrom, whereExtra);
  const url =
    `${API}/Tickets/customListTicket` +
    `?access_token=${encodeURIComponent(token)}` +
    `&memberId=${encodeURIComponent(memberId)}` +
    `&q=${encodeURIComponent(q)}`;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://sfsupport.dataon.com",
    "Referer": "https://sfsupport.dataon.com/app/ticket/list",
  };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[fetchTickets] HTTP ${res.status} — memberId=${memberId} body=${body.slice(0, 300)}`);
    throw new Error(`Ticket API failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Data helpers ───────────────────────────────────────────────────────────────

function dateOnly(s?: string | null): string {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function statusOf(t: RawTicket): string {
  return (t.status?.description ?? "").toLowerCase();
}

function severityOf(t: RawTicket): string {
  return t.sla?.label ?? t.sla?.description ?? "";
}

// ── Transform API response → DashboardCache ────────────────────────────────────

function transformTickets(
  tickets: RawTicket[]
): Omit<DashboardCache, "scrapedAt" | "error"> {
  const UNRESOLVED = new Set(["open", "responded", "reopen"]);

  const recentTickets: RecentTicket[] = tickets.map((t) => ({
    task:         t.type?.description ?? "",
    ticketNo:     t.documentNo ?? "",
    createdDate:  dateOnly(t.createdAt),
    reportedDate: dateOnly(t.reportedDate),
    fixedDate:    (() => {
      const resolved = ["fixed","closed","cancelled"].includes(statusOf(t));
      return dateOnly(t.fixedDate ?? t.verifiedDate ?? t.closedDate ?? (resolved ? t.planEnd : undefined));
    })(),
    project:      t.project?.projectName ?? "",
    module:       t.module?.description?.trim() ?? "",
    subject:      t.subject ?? "",
    severity:     severityOf(t),
    completion:   t.completenessPercentage != null ? `${t.completenessPercentage}%` : "",
    status:       t.status?.description ?? "",
  }));

  const unresolvedTickets: TicketRow[] = tickets
    .filter((t) => UNRESOLVED.has(statusOf(t)))
    .map((t) => ({
      documentNo:   t.documentNo ?? "",
      project:      t.project?.projectName ?? "",
      type:         t.type?.description ?? "",
      status:       t.status?.description ?? "",
      reportedDate: dateOnly(t.reportedDate),
    }));

  const unrespondedTickets: TicketRow[] = tickets
    .filter((t) => statusOf(t) === "open")
    .map((t) => ({
      documentNo:   t.documentNo ?? "",
      project:      t.project?.projectName ?? "",
      type:         t.type?.description ?? "",
      status:       t.status?.description ?? "",
      reportedDate: dateOnly(t.reportedDate),
    }));

  const totals: DashboardCache["totals"] = {
    all:         tickets.length,
    open:        tickets.filter((t) => statusOf(t) === "open").length,
    responded:   tickets.filter((t) => statusOf(t) === "responded").length,
    reopen:      tickets.filter((t) => statusOf(t) === "reopen").length,
    fixed:       tickets.filter((t) => statusOf(t) === "fixed").length,
    closed:      tickets.filter((t) => statusOf(t) === "closed").length,
    cancelled:   tickets.filter((t) => statusOf(t) === "cancelled").length,
    unresolved:  unresolvedTickets.length,
    unresponded: unrespondedTickets.length,
  };

  // Module breakdown
  const moduleMap = new Map<string, ModuleRow>();
  for (const t of tickets) {
    const mod = t.module?.description?.trim() ?? "(Unknown)";
    const sev = severityOf(t).toLowerCase();
    const st  = statusOf(t);
    if (!moduleMap.has(mod)) {
      moduleMap.set(mod, {
        module: mod, total: 0,
        critical: 0, high: 0, medium: 0, low: 0,
        open: 0, responded: 0, reopen: 0, fixed: 0, closed: 0, cancelled: 0,
      });
    }
    const row = moduleMap.get(mod)!;
    row.total++;
    if (sev === "critical")      row.critical++;
    else if (sev === "high")     row.high++;
    else if (sev === "medium")   row.medium++;
    else if (sev === "low")      row.low++;
    if (st === "open")           row.open++;
    else if (st === "responded") row.responded++;
    else if (st === "reopen")    row.reopen++;
    else if (st === "fixed")     row.fixed++;
    else if (st === "closed")    row.closed++;
    else if (st === "cancelled") row.cancelled++;
  }
  const moduleBreakdown = [...moduleMap.values()].sort((a, b) => b.total - a.total);

  // Severity breakdown
  const sevMap = new Map<string, SeverityRow>();
  for (const t of tickets) {
    const sev = severityOf(t) || "(Unknown)";
    const st  = statusOf(t);
    if (!sevMap.has(sev)) {
      sevMap.set(sev, { severity: sev, open: 0, responded: 0, reopen: 0, fixed: 0, closed: 0, cancelled: 0 });
    }
    const row = sevMap.get(sev)!;
    if (st === "open")           row.open++;
    else if (st === "responded") row.responded++;
    else if (st === "reopen")    row.reopen++;
    else if (st === "fixed")     row.fixed++;
    else if (st === "closed")    row.closed++;
    else if (st === "cancelled") row.cancelled++;
  }
  const severityBreakdown = [...sevMap.values()];

  // Derive period from ticket dates
  const dates = tickets
    .map((t) => dateOnly(t.reportedDate))
    .filter(Boolean)
    .sort();
  const periodStr = dates.length ? `${dates[0]} TO ${dates[dates.length - 1]}` : "";

  return {
    totals,
    statisticPeriod: periodStr,
    partnerPeriod:   periodStr,
    unresolvedTickets,
    unrespondedTickets,
    moduleBreakdown,
    severityBreakdown,
    recentTickets,
  };
}

// ── Main scrape ────────────────────────────────────────────────────────────────

export async function scrape(
  username: string,
  password: string,
  targetDateFrom?: string,
  memberId?: string
): Promise<void> {
  const startedAt = new Date().toISOString();
  saveProgress({ phase: "Authenticating", current: 0, total: 3, startedAt }, username);

  const empty: DashboardCache = {
    scrapedAt: startedAt,
    error: null,
    totals: { all: 0, open: 0, responded: 0, reopen: 0, fixed: 0, closed: 0, cancelled: 0, unresolved: 0, unresponded: 0 },
    statisticPeriod: "", partnerPeriod: "",
    unresolvedTickets: [], unrespondedTickets: [],
    moduleBreakdown: [], severityBreakdown: [], recentTickets: [],
  };

  try {
    const auth = await verifyLogin(username, password);
    if (!auth.ok) throw new Error(auth.error);
    saveProgress({ phase: "Fetching tickets", current: 1, total: 3, startedAt }, username);

    const tickets = await fetchTickets(auth.token, memberId ?? auth.memberId, auth.cookie, targetDateFrom);
    console.log(`[scrape] ${username}: fetched ${tickets.length} tickets`);
    saveProgress({ phase: "Saving", current: 2, total: 3, startedAt }, username);

    await saveCache(
      { ...empty, scrapedAt: new Date().toISOString(), ...transformTickets(tickets) },
      username
    );
  } catch (e) {
    console.error("[scrape] error:", e);
    await saveCache({ ...empty, error: e instanceof Error ? e.message : String(e) }, username);
  } finally {
    clearProgress(username);
  }
}

// ── Ticket detail ──────────────────────────────────────────────────────────────

export interface TicketDetail {
  fields: Record<string, string>;
  url: string;
}

export async function scrapeTicketDetail(
  username: string,
  password: string,
  ticketNo: string
): Promise<TicketDetail | { error: string }> {
  const auth = await verifyLogin(username, password);
  if (!auth.ok) return { error: auth.error };

  const q = JSON.stringify({
    fields: [
      "id", "documentNo", "subject", "reportedDate", "createdAt", "updatedAt",
      "remark", "rootCause", "correctiveAction", "planStart", "planEnd", "estimatedManhours",
    ],
    include: [
      "sla", "module", "status", "project", "type", "rootCauseCategory",
      {
        relation: "ticketMembers",
        scope: {
          include: {
            relation: "member",
            scope: {
              include: {
                relation: "memberDetail",
                scope: { fields: ["firstName", "middleName", "lastName"] },
              },
            },
          },
        },
      },
      "attachments",
    ],
    where: { documentNo: ticketNo },
  });

  const url =
    `${API}/Tickets/customListTicket` +
    `?access_token=${encodeURIComponent(auth.token)}` +
    `&memberId=${encodeURIComponent(auth.memberId)}` +
    `&q=${encodeURIComponent(q)}`;
  const headers: Record<string, string> = {};
  if (auth.cookie) headers["Cookie"] = auth.cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) return { error: `Ticket API failed (HTTP ${res.status})` };

  const list: RawTicket[] = await res.json();
  const t = list[0];
  if (!t) return { error: `Ticket ${ticketNo} not found.` };

  const memberName = (tm: NonNullable<RawTicket["ticketMembers"]>[number]) => {
    const md = tm?.member?.memberDetail;
    return [md?.firstName, md?.middleName, md?.lastName].filter(Boolean).join(" ");
  };
  const assignees = (t.ticketMembers ?? []).map(memberName).filter(Boolean).join(", ");

  const fields: Record<string, string> = {
    "Document No":       t.documentNo ?? "",
    "Subject":           t.subject ?? "",
    "Project":           t.project?.projectName ?? "",
    "Module":            t.module?.description?.trim() ?? "",
    "Type":              t.type?.description ?? "",
    "Status":            t.status?.description ?? "",
    "Severity":          severityOf(t),
    "Reported Date":     dateOnly(t.reportedDate),
    "Created Date":      dateOnly(t.createdAt),
    "Updated Date":      dateOnly(t.updatedAt),
    "Plan Start":        dateOnly(t.planStart),
    "Plan End":          dateOnly(t.planEnd),
    "Remark":            t.remark ?? "",
    "Root Cause":        t.rootCause ?? "",
    "Corrective Action": t.correctiveAction ?? "",
    "Assigned To":       assignees,
  };
  for (const k of Object.keys(fields)) {
    if (!fields[k]) delete fields[k];
  }

  return { fields, url: `${BASE}/app/ticket/forms/${ticketNo}` };
}
