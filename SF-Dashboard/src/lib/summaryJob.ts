// Shared daily-summary fan-out. Called both by the in-process node-cron
// scheduler (instrumentation.ts, for Render/long-running servers) and by the
// HTTP endpoint (/api/cron/summary, for external triggers).

import {
  listScheduledSummaryUsers,
  loadSummarySettings,
  loadCredentials,
  loadCache,
} from "./store";
import { scrape } from "./scraper";
import { sendMail, emailConfigured } from "./email";
import { renderSummaryHtml, summarySubject, cacheToSummaryData, withPermanentRecipients } from "./summary";

export interface SummaryRunResult {
  ok: boolean;
  processed: number;
  results: { user: string; sent?: number; error?: string }[];
  error?: string;
}

export async function runScheduledSummaries(): Promise<SummaryRunResult> {
  if (!emailConfigured()) {
    return { ok: false, processed: 0, results: [], error: "Email not configured." };
  }

  const users = await listScheduledSummaryUsers();
  const results: SummaryRunResult["results"] = [];

  for (const user of users) {
    try {
      const settings = await loadSummarySettings(user);
      if (!settings.scheduleEnabled) continue;

      // Best-effort refresh so the email reflects current data.
      const creds = await loadCredentials(user);
      if (creds) {
        await scrape(
          creds.username, creds.password, undefined,
          creds.memberId, creds.token, creds.cookie
        ).catch((e) => console.error(`[summaryJob] refresh failed for ${user}:`, e));
      }

      const cache = await loadCache(user);
      if (!cache) { results.push({ user, error: "no cache" }); continue; }

      const displayName = creds?.username ?? user;
      const recipients = withPermanentRecipients(settings.recipients, creds?.username ?? user);
      const summary = cacheToSummaryData(cache);
      await sendMail({
        to: recipients,
        subject: summarySubject(summary, displayName),
        html: renderSummaryHtml(summary, displayName),
      });
      results.push({ user, sent: recipients.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[summaryJob] ${user}:`, msg);
      results.push({ user, error: msg });
    }
  }

  return { ok: true, processed: results.length, results };
}
