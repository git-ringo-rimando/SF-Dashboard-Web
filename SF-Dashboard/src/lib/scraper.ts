import puppeteer, { type Browser, type Page, type Cookie } from "puppeteer";
import {
  saveCache,
  loadCache,
  saveProgress,
  clearProgress,
  type DashboardCache,
  type TicketRow,
  type ModuleRow,
  type SeverityRow,
  type RecentTicket,
} from "./store";

const BASE = "https://sfsupport.dataon.com";

async function getBrowser(): Promise<Browser> {
  const executablePath = process.env.CHROMIUM_PATH ?? undefined;
  const isLinux = process.platform === "linux";
  console.log("[browser] launching chromium:", executablePath ?? "puppeteer default");
  return puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      // single-process/no-zygote stabilise Chromium inside Linux Docker containers
      // but cause crashes on Windows — only enable on Linux
      ...(isLinux ? ["--single-process", "--no-zygote"] : []),
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
    ],
    protocolTimeout: 360_000,
  });
}

/** page.goto with retry on navigation timeout or transient network errors.
 *  Uses "commit" so it resolves on first byte — the caller then waits for
 *  a selector, which is more reliable on slow connections than waiting for
 *  the full domcontentloaded event chain to complete within a deadline. */
async function safeGoto(page: Page, url: string, timeout = 120000): Promise<void> {
  const RETRYABLE = /Navigation timeout|net::ERR_|TimeoutError/i;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout });
      return;
    } catch (e) {
      const msg = String(e);
      if (RETRYABLE.test(msg) && attempt < 3) {
        console.log(`[goto] attempt ${attempt} timed out for ${url}, retrying…`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw e;
    }
  }
}

/** Navigate and wait for a selector; if the selector never appears (e.g. empty
 *  table) we settle for 3 extra seconds instead of throwing. */
async function gotoAndWait(page: Page, url: string, selector: string, timeout = 90000) {
  await safeGoto(page, url);
  await page.waitForSelector(selector, { timeout }).catch(() =>
    new Promise<void>((r) => setTimeout(r, 3000))
  );
}

/** Retry a page.evaluate() call if Angular destroys the execution context mid-flight. */
async function retryOnDetach<T>(fn: () => Promise<T>, page: Page, retries = 3): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e);
      if (
        (msg.includes("detached Frame") || msg.includes("Execution context was destroyed")) &&
        attempt < retries - 1
      ) {
        await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("retryOnDetach: failed after all retries");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.setUserAgent(UA);
  return page;
}

/** Run a scrape function on a fresh page sharing the same session cookies. */
async function runOnNewPage<T>(
  browser: Browser,
  cookies: Awaited<ReturnType<Page["cookies"]>>,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const page = await newPage(browser);
  if (cookies.length) await page.setCookie(...cookies);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function fillLoginForm(page: Page, username: string, password: string): Promise<boolean> {
  const userField =
    (await page.$('input[name="username"]')) ??
    (await page.$('input[name="email"]')) ??
    (await page.$('input[type="email"]')) ??
    (await page.$('input[id*="user"]')) ??
    (await page.$('input[id*="email"]')) ??
    (await page.$("input[type='text'].ui-inputtext")) ??
    (await page.$("input[type='text']"));

  const passField =
    (await page.$('input[name="password"]')) ?? (await page.$('input[type="password"]'));

  if (!userField || !passField) return false;

  await userField.click({ clickCount: 3 });
  await userField.type(username, { delay: 20 });
  await passField.click({ clickCount: 3 });
  await passField.type(password, { delay: 20 });

  const submitted = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim().toLowerCase() === "sign in" || b.getAttribute("type") === "submit"
    ) as HTMLElement | undefined;
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!submitted) await passField.press("Enter");
  return true;
}

async function doLogin(
  page: Page,
  username: string,
  password: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cdp = await page.createCDPSession();
  await cdp.send("Network.clearBrowserCookies");
  await cdp.detach();

  await safeGoto(page, BASE);

  try {
    await page.waitForSelector('input[type="password"]', { timeout: 120000 });
  } catch {
    return { ok: false, error: "Login page did not render — the site may be down." };
  }

  if (!(await fillLoginForm(page, username, password))) {
    return { ok: false, error: "Could not find the login form on the page." };
  }

  try {
    await page.waitForSelector('a[href*="/app/"], [routerlink*="/app/"]', { timeout: 60000 });
  } catch {
    const hasPassword = !!(await page.$('input[type="password"]'));
    if (hasPassword) {
      const visibleError = await page.evaluate(() =>
        document.querySelector(".error-message, .alert-danger, [role='alert'], [class*='error']")
          ?.textContent?.trim() ?? null
      );
      return { ok: false, error: visibleError ?? "Invalid username or password." };
    }
  }

  return { ok: true };
}

export async function verifyLogin(
  username: string,
  password: string
): Promise<{ ok: true; cookies: Cookie[] } | { ok: false; error: string }> {
  const browser = await getBrowser();
  const page = await newPage(browser);
  try {
    const result = await doLogin(page, username, password);
    if (result.ok) {
      const cookies = await page.cookies();
      return { ok: true, cookies };
    }
    return result;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── Page extractors ───────────────────────────────────────────────────────────

async function extractPartnerDashboard(page: Page): Promise<{
  period: string;
  unresolvedTickets: TicketRow[];
  unrespondedTickets: TicketRow[];
  unresolvedCount: number;
  unrespondedCount: number;
}> {
  await gotoAndWait(page, `${BASE}/app/partner-dashboard`, "table");

  return retryOnDetach(() => page.evaluate(() => {
    const periodMatch = document.body.innerText.match(/PERIODE\s+([\d\w\s]+TO[\d\w\s]+)/i);
    const period = periodMatch ? periodMatch[1].trim() : "";
    const tables = [...document.querySelectorAll("table")];

    function parseTable(table: Element): TicketRow[] {
      return [...table.querySelectorAll("tbody tr")]
        .map((tr) => {
          const c = [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? "");
          return { documentNo: c[0], project: c[1], type: c[2], status: c[3], reportedDate: c[4] };
        })
        .filter((r) => r.documentNo);
    }

    const t0 = tables[0] ? parseTable(tables[0]) : [];
    const t1 = tables[1] ? parseTable(tables[1]) : [];
    return { period, unresolvedTickets: t0, unrespondedTickets: t1, unresolvedCount: t0.length, unrespondedCount: t1.length };
  }), page);
}

async function extractStatistics(page: Page): Promise<{
  period: string;
  moduleBreakdown: ModuleRow[];
  severityBreakdown: SeverityRow[];
  totals: DashboardCache["totals"];
}> {
  await gotoAndWait(page, `${BASE}/app/ticket/statistic`, "table");

  // Wait for Angular to populate the table with actual numeric data
  await page.waitForFunction(
    () => {
      const cell = document.querySelector("table tbody tr td:nth-child(2)");
      return !!cell && /\d/.test(cell.textContent ?? "");
    },
    { timeout: 60000 }
  ).catch(() => {});

  return retryOnDetach(() => page.evaluate(() => {
    const num = (s: string | undefined) => parseInt(s ?? "0") || 0;
    const periodInput =
      (document.querySelector('input[type="text"]') as HTMLInputElement)?.value ??
      document.querySelector(".ui-inputtext")?.textContent?.trim() ?? "";

    const tables = [...document.querySelectorAll("table")];
    const moduleRows: ModuleRow[] = [];
    if (tables[0]) {
      [...tables[0].querySelectorAll("tbody tr")].forEach((tr) => {
        const c = [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? "");
        if (!c[0] || c[0].toLowerCase() === "total") return;
        moduleRows.push({
          module: c[0], total: num(c[1]),
          critical: num(c[2]), high: num(c[3]), medium: num(c[4]), low: num(c[5]),
          open: num(c[6]), responded: num(c[7]), reopen: num(c[8]),
          fixed: num(c[9]), closed: num(c[10]), cancelled: num(c[11]),
        });
      });
    }

    let totals = { all: 0, open: 0, responded: 0, reopen: 0, fixed: 0, closed: 0, cancelled: 0, unresolved: 0, unresponded: 0 };
    if (tables[0]) {
      const totalRow =
        tables[0].querySelector("tfoot tr") ??
        [...tables[0].querySelectorAll("tbody tr")].findLast(
          (r) => r.querySelector("td")?.textContent?.trim().toLowerCase() === "total"
        );
      if (totalRow) {
        const c = [...totalRow.querySelectorAll("td, th")].map((el) => el.textContent?.trim() ?? "");
        totals = { ...totals, all: num(c[1]), open: num(c[6]), responded: num(c[7]), reopen: num(c[8]), fixed: num(c[9]), closed: num(c[10]), cancelled: num(c[11]) };
      }
    }

    const severityRows: SeverityRow[] = [];
    if (tables[1]) {
      [...tables[1].querySelectorAll("tbody tr")].forEach((tr) => {
        const c = [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? "");
        if (!c[0] || c[0].toLowerCase() === "total") return;
        severityRows.push({ severity: c[0], open: num(c[1]), responded: num(c[2]), reopen: num(c[3]), fixed: num(c[4]), closed: num(c[5]), cancelled: num(c[6]) });
      });
    }

    return { period: periodInput, moduleBreakdown: moduleRows, severityBreakdown: severityRows, totals };
  }), page);
}

// ── Date helper (server-side) ─────────────────────────────────────────────────

function toDateOnlyServer(s: string): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const M: Record<string, string> = {
    Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
    Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12",
  };
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})/i);
  if (m) {
    const mon = M[m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

// ── Ticket list with fast pagination ─────────────────────────────────────────

/** Wait until the ticket list table has at least one row with a non-empty
 *  ticket number cell — this ensures Angular has finished loading the data,
 *  not just rendered empty placeholder rows. */
async function waitForTicketData(page: Page, timeout = 90000): Promise<void> {
  await page.waitForFunction(
    () => {
      const cell = document.querySelector("table tbody tr td:nth-child(2)");
      return !!cell && (cell.textContent?.trim().length ?? 0) > 0;
    },
    { timeout }
  ).catch(() => {});
}

async function extractTicketList(page: Page, startedAt: string, targetDateFrom?: string, onFirstPage?: (tickets: RecentTicket[]) => Promise<void>): Promise<RecentTicket[]> {
  // Always navigate fresh so we never use a partially-rendered page left by
  // ensureAuthenticated (which resolves as soon as any row appears — not all rows).
  await safeGoto(page, `${BASE}/app/ticket/list`);
  await waitForTicketData(page);
  // Poll until the visible row count stops changing — Angular renders rows progressively
  // and the first row appearing does not guarantee all rows are in the DOM yet.
  let prevCount = -1;
  for (let i = 0; i < 8; i++) {
    const count: number = await page.evaluate(
      () => document.querySelectorAll("table tbody tr").length
    );
    if (count > 0 && count === prevCount) break;
    prevCount = count;
    await new Promise((r) => setTimeout(r, 400));
  }

  const all: RecentTicket[] = [];
  const MAX_PAGES = targetDateFrom ? 200 : 75;

  for (let p = 0; p < MAX_PAGES; p++) {
    saveProgress({ phase: "Fetching tickets", current: p + 1, total: MAX_PAGES, startedAt });
    // Recover from detached frame caused by Angular re-renders during pagination
    let pageResult: { tickets: RecentTicket[]; hasNext: boolean; firstTicketNo: string };
    try {
      pageResult = await page.evaluate(() => {
        const rows: RecentTicket[] = [];
        // Extract full datetime from a cell — checks title attr, all child text nodes,
        // and any span/label that might carry the time portion.
        function cellDateTime(cell: Element): string {
          const title = cell.getAttribute("title")?.trim();
          if (title && title.length > 0) return title;
          const full = [...cell.childNodes]
            .map((n) => n.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ");
          return full || (cell.textContent?.trim() ?? "");
        }

        document.querySelectorAll("table tbody tr").forEach((tr) => {
          const cells = [...tr.querySelectorAll("td")];
          if (cells.length < 10) return;
          const rawStatus = cells[10]?.textContent?.trim() ?? "";
          rows.push({
            task:         cells[0]?.textContent?.trim() ?? "",
            ticketNo:     cells[1]?.textContent?.trim() ?? "",
            createdDate:  cellDateTime(cells[2]),
            reportedDate: cellDateTime(cells[3]),
            fixedDate:    cellDateTime(cells[4]),
            project:      cells[5]?.textContent?.trim() ?? "",
            module:       cells[6]?.textContent?.trim() ?? "",
            subject:      cells[7]?.textContent?.trim() ?? "",
            severity:     cells[8]?.textContent?.trim() ?? "",
            completion:   cells[9]?.textContent?.trim() ?? "",
            status:       rawStatus.replace(/\d+\s*ui-btn/gi, "").trim(),
          });
        });
        const nextBtn = document.querySelector(".ui-paginator-next");
        return {
          tickets:       rows.filter((t) => t.ticketNo),
          hasNext:       !!nextBtn && !nextBtn.classList.contains("ui-state-disabled"),
          firstTicketNo: rows[0]?.ticketNo ?? "",
        };
      });
    } catch (e) {
      const msg = String(e);
      if (msg.includes("detached Frame") || msg.includes("Execution context was destroyed")) {
        await new Promise((r) => setTimeout(r, 1500));
        await waitForTicketData(page, 15000);
        continue;
      }
      throw e;
    }

    const { tickets, hasNext, firstTicketNo } = pageResult;
    all.push(...tickets);

    if (p === 0 && tickets.length > 0 && onFirstPage) {
      await onFirstPage(tickets).catch(() => {});
    }

    // Stop when oldest ticket on page is BEFORE the target date.
    // Use strict < so tickets from the target date itself are fully captured
    // across all pages (guards against stopping early when all tickets share the same date).
    if (targetDateFrom && tickets.length > 0) {
      const oldest = toDateOnlyServer(tickets[tickets.length - 1].createdDate);
      if (oldest && oldest < targetDateFrom) break;
    }

    if (!hasNext) break;

    // Fast page turn: click Next, then wait only until the first row changes
    await page.click(".ui-paginator-next").catch(() => {});
    await page
      .waitForFunction(
        (prev) => {
          const el = document.querySelector("table tbody tr:first-child td:nth-child(2)");
          return !!el && el.textContent?.trim() !== prev;
        },
        { timeout: 15000 },
        firstTicketNo
      )
      .catch(() => {});
  }

  return all;
}

// ── Ticket detail ─────────────────────────────────────────────────────────────

export interface TicketDetail {
  fields: Record<string, string>;
  url: string;
}

export async function scrapeTicketDetail(
  username: string,
  password: string,
  ticketNo: string,
): Promise<TicketDetail | { error: string }> {
  const browser = await getBrowser();
  const page = await newPage(browser);

  try {
    // Navigate then wait briefly for Angular's client-side router to settle.
    // domcontentloaded fires before Angular routes; networkidle2 is too slow on
    // data-heavy pages. A short fixed wait is the right tradeoff here.
    const directUrl = `${BASE}/app/ticket/forms/${ticketNo}`;
    await safeGoto(page, directUrl).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500)); // let Angular router finish

    // After networkidle2 the URL reflects Angular's final route
    const onLogin = page.url().includes("/login") || page.url().includes("/sign-in");
    if (onLogin) {
      // Need to authenticate — login form should already be rendered
      const hasForm = !!(await page.$('input[type="password"]'));
      if (!hasForm) {
        // Not a login page — ticket is simply inaccessible at this URL
        // Skip to partner dashboard fallback below
      } else {
        if (!(await fillLoginForm(page, username, password))) {
          return { error: "Could not find login form." };
        }
        try {
          await page.waitForSelector('a[href*="/app/"], [routerlink*="/app/"]', { timeout: 60000 });
        } catch {
          if (await page.$('input[type="password"]'))
            return { error: "Invalid username or password." };
        }
        await safeGoto(page, directUrl).catch(() => {});
        await new Promise((r) => setTimeout(r, 2500));
      }
    }

    // Must land on a page whose URL contains the ticket number itself
    let navigated = page.url().includes(ticketNo);

    // Fallback A: try alternate URL patterns
    if (!navigated) {
      for (const url of [
        `${BASE}/app/ticket/detail/${ticketNo}`,
        `${BASE}/app/ticket/view/${ticketNo}`,
      ]) {
        await safeGoto(page, url).catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
        if (page.url().includes(ticketNo)) { navigated = true; break; }
      }
    }

    // Fallback B: find the ticket link in the partner dashboard tables and click it
    // Fallback B: partner dashboard — grab the href from the row link directly
    if (!navigated) {
      await gotoAndWait(page, `${BASE}/app/partner-dashboard`, "table");
      const rowHref = await page.evaluate((tNo: string) => {
        for (const row of document.querySelectorAll("table tbody tr")) {
          const cells = [...row.querySelectorAll("td")];
          if (cells[0]?.textContent?.trim() === tNo) {
            const a = row.querySelector("a") as HTMLAnchorElement | null;
            return a?.href ?? "ROW";
          }
        }
        return null;
      }, ticketNo);

      if (rowHref && rowHref !== "ROW") {
        await safeGoto(page, rowHref).catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
        navigated = page.url().includes(ticketNo);
      } else if (rowHref === "ROW") {
        // Click and wait briefly for client-side navigation
        await page.evaluate((tNo: string) => {
          for (const row of document.querySelectorAll("table tbody tr")) {
            if ([...row.querySelectorAll("td")][0]?.textContent?.trim() === tNo)
              (row as HTMLElement).click();
          }
        }, ticketNo);
        await new Promise((r) => setTimeout(r, 3000));
        navigated = page.url().includes(ticketNo);
      }
    }

    if (!navigated) return { error: `Detail page for ${ticketNo} is not accessible from this account. Only cached summary data is available.` };

    // Wait for Angular/PrimeFaces to finish rendering the detail form
    await page.waitForSelector("label, .ui-outputlabel, form, table", { timeout: 20000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    const fields = await page.evaluate(() => {
      const result: Record<string, string> = {};
      const clean = (s: string) => s.replace(/\s+/g, " ").trim().replace(/:$/, "").trim();
      const set = (k: string, v: string) => { if (k && v && !result[k]) result[k] = v; };

      // ── Strategy 1: label[for] → element by ID (PrimeFaces .ui-outputlabel pattern) ──
      document.querySelectorAll("label[for], .ui-outputlabel[for]").forEach((label) => {
        const key = clean(label.textContent ?? "");
        if (!key || key.length > 80) return;
        const forId = label.getAttribute("for") ?? "";
        const target = forId ? document.getElementById(forId) : null;
        if (target) {
          // Could be an input, span, div, or p-autocomplete input
          const val = clean(
            (target as HTMLInputElement).value ||
            target.querySelector("input")?.value ||
            target.querySelector("[class*='label'], span, .ui-inputtext")?.textContent ||
            target.textContent ||
            ""
          );
          if (val) set(key, val);
        }
      });

      // ── Strategy 2: label/span → next sibling (generic proximity) ──
      document.querySelectorAll("label, .ui-outputlabel, .label, th").forEach((el) => {
        const key = clean(el.textContent ?? "");
        if (!key || key.length > 80) return;
        const sib = el.nextElementSibling as HTMLElement | null;
        if (sib) {
          const val = clean(
            (sib as HTMLInputElement).value || sib.textContent || ""
          );
          if (val && val !== key) set(key, val);
        }
      });

      // ── Strategy 3: 2-cell <tr> rows ──
      document.querySelectorAll("tr").forEach((tr) => {
        const c = [...tr.querySelectorAll("td, th")];
        if (c.length === 2) {
          const k = clean(c[0].textContent ?? "");
          const v = clean((c[1] as HTMLInputElement).value || c[1].textContent || "");
          if (k && v && k.length < 60) set(k, v);
        }
      });

      // ── Strategy 4: <dt>/<dd> pairs ──
      document.querySelectorAll("dt").forEach((dt) => {
        const key = clean(dt.textContent ?? "");
        const dd = dt.nextElementSibling;
        if (key && dd?.tagName === "DD") set(key, clean(dd.textContent ?? ""));
      });

      // ── Strategy 5: targeted assignee — search every visible element whose
      //    text looks like a field label containing "assign" / "pic" / "handler" ──
      const ASSIGNEE_LABELS = /primary\s*assignee|assignee|assigned\s*to|handler|pic\b|person\s*in\s*charge/i;
      const walked = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node: Element | null;
      while ((node = walked.nextNode() as Element | null)) {
        const tag = node.tagName.toLowerCase();
        if (["script","style","svg","path","head"].includes(tag)) continue;
        const txt = (node.childNodes.length === 1 && node.childNodes[0].nodeType === 3)
          ? node.textContent?.trim() ?? ""
          : "";
        if (!txt || txt.length > 80 || !ASSIGNEE_LABELS.test(txt)) continue;
        const key = clean(txt);
        // Look at next sibling, parent's next sibling, and nearby inputs
        const candidates: (Element | null)[] = [
          node.nextElementSibling,
          node.parentElement?.nextElementSibling ?? null,
          node.closest("td")?.nextElementSibling ?? null,
          node.closest("th")?.nextElementSibling ?? null,
          node.closest("label")?.nextElementSibling ?? null,
        ];
        for (const c of candidates) {
          if (!c) continue;
          const val = clean(
            (c as HTMLInputElement).value ||
            c.querySelector("input")?.value ||
            c.querySelector("span, .ui-inputtext, [class*='value']")?.textContent ||
            c.textContent ||
            ""
          );
          if (val && val !== key && val.length < 100) { set(key, val); break; }
        }
      }

      // ── Strategy 6: regex scan of full page text for assignee lines ──
      const bodyText = document.body.innerText;
      const patterns: [RegExp, string][] = [
        [/Primary\s*Assignee\s*[:\-]?\s*(.+)/i,      "Primary Assignee"],
        [/Assignee\s*[:\-]?\s*(.+)/i,                "Assignee"],
        [/Assigned\s*To\s*[:\-]?\s*(.+)/i,           "Assigned To"],
        [/Handler\s*[:\-]?\s*(.+)/i,                 "Handler"],
        [/PIC\s*[:\-]?\s*(.+)/i,                     "PIC"],
        [/Person\s*In\s*Charge\s*[:\-]?\s*(.+)/i,    "Person In Charge"],
      ];
      for (const [rx, label] of patterns) {
        const m = bodyText.match(rx);
        if (m) {
          const val = m[1].split("\n")[0].trim();
          if (val && val.length < 120) set(label, val);
        }
      }

      // ── Strategy 7: any element whose id/class/name contains "assign" or "pic" ──
      document.querySelectorAll(
        "[id*='assign'],[class*='assign'],[name*='assign']," +
        "[id*='primaryAssign'],[id*='primary_assign']," +
        "[id*='pic'],[name*='pic']"
      ).forEach((el) => {
        const val = clean((el as HTMLInputElement).value || el.textContent || "");
        if (val && val.length < 120) {
          const label = el.getAttribute("placeholder") || el.getAttribute("aria-label") ||
                        el.id || el.className.split(" ")[0] || "Assigned To";
          set(clean(label), val);
        }
      });

      return result;
    });

    return { fields, url: page.url() };
  } finally {
    await page.close();
  }
}

// ── Auth guard ────────────────────────────────────────────────────────────────

function isLoginUrl(url: string) {
  return url.includes("/login") || url.includes("/sign-in");
}

async function ensureAuthenticated(
  page: Page,
  username: string,
  password: string,
  sessionCookies?: Cookie[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (sessionCookies?.length) {
    await page.setCookie(...sessionCookies);
  }
  await safeGoto(page, `${BASE}/app/ticket/list`);

  // Angular boots after domcontentloaded and may redirect to login — wait for
  // either the ticket table OR the password field, whichever appears first.
  await page.waitForFunction(
    () => !!document.querySelector("table tbody tr, input[type='password']"),
    { timeout: 90000 }
  ).catch(() => {});

  const landed = page.url();

  if (isLoginUrl(landed) || !!(await page.$('input[type="password"]'))) {
    return doLogin(page, username, password);
  }

  return { ok: true };
}

// ── Created-time enrichment ───────────────────────────────────────────────────

async function fetchCreatedTime(page: Page, ticketNo: string): Promise<string | null> {
  try {
  const url = `${BASE}/app/ticket/forms/${ticketNo}`;
  await safeGoto(page, url).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  return await page.evaluate(() => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const KEYS = ["createddate", "createdate", "datecreated", "creationdate", "created"];
    const candidates = [
      ...document.querySelectorAll("label, .ui-outputlabel, th, dt, td"),
    ];
    for (const el of candidates) {
      if (!KEYS.includes(norm(el.textContent ?? ""))) continue;
      // Try sibling / next cell / parent's next sibling for the value
      const valueEl =
        el.nextElementSibling ??
        el.parentElement?.nextElementSibling?.querySelector("td, span, input") ??
        null;
      if (!valueEl) continue;
      const val =
        (valueEl as HTMLInputElement).value?.trim() ||
        valueEl.getAttribute("title")?.trim() ||
        valueEl.textContent?.trim() ||
        "";
      // Must look like a date with time (contains digits and colon)
      if (val && /\d/.test(val) && /:/.test(val)) return val;
    }
    return null;
  });
  } catch {
    return null;
  }
}

// Run an async function over an array with at most `concurrency` parallel tasks
async function pLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrape(username: string, password: string, targetDateFrom?: string, sessionCookies?: Cookie[]): Promise<void> {
  // Write progress before launching the browser so the dashboard detects it immediately
  const startedAt = new Date().toISOString();
  saveProgress({ phase: "Launching browser", current: 0, total: 1, startedAt });

  const browser = await getBrowser();
  const page = await newPage(browser);

  const empty: DashboardCache = {
    scrapedAt: new Date().toISOString(),
    error: null,
    totals: { all: 0, open: 0, responded: 0, reopen: 0, fixed: 0, closed: 0, cancelled: 0, unresolved: 0, unresponded: 0 },
    statisticPeriod: "", partnerPeriod: "",
    unresolvedTickets: [], unrespondedTickets: [],
    moduleBreakdown: [], severityBreakdown: [], recentTickets: [],
  };

  try {
    // Build a map of previously enriched creation times so we never open a
    // detail page for a ticket we've already resolved. On the very first scrape
    // this map is empty; on subsequent scrapes it short-circuits most lookups.
    const existingCache = await loadCache();
    const knownTimes = new Map<string, string>(
      (existingCache?.recentTickets ?? [])
        .filter((t) => t.createdDate.includes(":"))
        .map((t) => [t.ticketNo, t.createdDate])
    );

    saveProgress({ phase: "Authenticating", current: 0, total: 1, startedAt });
    const auth = await ensureAuthenticated(page, username, password, sessionCookies);
    if (!auth.ok) throw new Error(auth.error);
    saveProgress({ phase: "Authenticating", current: 1, total: 1, startedAt });

    // Copy session cookies so parallel pages share the same auth
    const cookies = await page.cookies();

    // Run sequentially to keep peak memory low on constrained hosts.
    saveProgress({ phase: "Fetching tickets", current: 0, total: 1, startedAt });
    const recentTickets = await extractTicketList(page, startedAt, targetDateFrom, async (firstPage) => {
      // Save a partial cache after the first page so the dashboard can render immediately
      await saveCache({ ...empty, scrapedAt: new Date().toISOString(), recentTickets: firstPage });
    });

    // Partner dashboard and statistics are independent — run in parallel
    saveProgress({ phase: "Fetching dashboard & statistics", current: 0, total: 1, startedAt });
    const [partnerData, statData] = await Promise.all([
      runOnNewPage(browser, cookies, extractPartnerDashboard),
      runOnNewPage(browser, cookies, extractStatistics),
    ]);

    // Apply previously enriched times before deciding what still needs a detail fetch.
    for (const ticket of recentTickets) {
      const known = knownTimes.get(ticket.ticketNo);
      if (known) ticket.createdDate = known;
    }

    // Only open detail pages for tickets still missing a time component.
    // On the initial scrape this covers up to 20 tickets; on subsequent scrapes
    // only brand-new tickets that haven't been seen before will be fetched.
    const needsEnrichment = recentTickets
      .slice(0, 20)
      .filter((t) => !t.createdDate.includes(":"));
    if (needsEnrichment.length > 0) {
      let enriched = 0;
      saveProgress({ phase: "Enriching ticket times", current: 0, total: needsEnrichment.length, startedAt });
      const times = await pLimit(needsEnrichment, 4, async (t) => {
        const result = await runOnNewPage(browser, cookies, (p) => fetchCreatedTime(p, t.ticketNo));
        saveProgress({ phase: "Enriching ticket times", current: ++enriched, total: needsEnrichment.length, startedAt });
        return result;
      });
      const timeMap = new Map(needsEnrichment.map((t, i) => [t.ticketNo, times[i]]));
      for (const ticket of recentTickets) {
        const t = timeMap.get(ticket.ticketNo);
        if (t) ticket.createdDate = t;
      }
    }

    saveProgress({ phase: "Saving", current: 1, total: 1, startedAt });

    await saveCache({
      ...empty,
      totals: { ...statData.totals, unresolved: partnerData.unresolvedCount, unresponded: partnerData.unrespondedCount },
      statisticPeriod: statData.period,
      partnerPeriod: partnerData.period,
      unresolvedTickets: partnerData.unresolvedTickets,
      unrespondedTickets: partnerData.unrespondedTickets,
      moduleBreakdown: statData.moduleBreakdown,
      severityBreakdown: statData.severityBreakdown,
      recentTickets,
    });
  } catch (e) {
    await saveCache({ ...empty, error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearProgress();
    await page.close();
    await browser.close();
  }
}
