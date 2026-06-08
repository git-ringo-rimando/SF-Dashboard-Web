// Runs once when the Node server boots. On long-running hosts (Render), this
// schedules the daily summary email in-process via node-cron — no external
// cron service needed.
//
// Configure with env vars (both optional):
//   SUMMARY_CRON  — cron expression (default "0 9 * * *" = 9:00 AM daily)
//   SUMMARY_TZ    — IANA timezone   (default "Asia/Manila")

let scheduled = false;

export async function register() {
  // Only run in the Node.js server runtime, never the edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Guard against double-scheduling on dev hot-reloads.
  if (scheduled) return;
  scheduled = true;

  const cron = (await import("node-cron")).default;
  const { runScheduledSummaries } = await import("./lib/summaryJob");

  const expr = process.env.SUMMARY_CRON ?? "0 9 * * *";
  const timezone = process.env.SUMMARY_TZ ?? "Asia/Manila";

  if (!cron.validate(expr)) {
    console.error(`[instrumentation] invalid SUMMARY_CRON "${expr}" — daily summary disabled`);
    return;
  }

  cron.schedule(expr, () => {
    runScheduledSummaries()
      .then((r) => console.log(`[summary-cron] processed ${r.processed} user(s)`))
      .catch((e) => console.error("[summary-cron] failed:", e));
  }, { timezone });

  console.log(`[instrumentation] daily summary scheduled "${expr}" (${timezone})`);
}
