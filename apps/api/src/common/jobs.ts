import { Logger } from "@nestjs/common";

/**
 * Background sweeps (reminders, dunning, digests, purges, …) run on timers in a
 * long-lived process. On a serverless host every warm instance would start the
 * same timers, fire the boot-time sweeps and tie up the tiny DB pool while real
 * requests queue behind them — so there `BACKGROUND_JOBS=off` disables the
 * timers and an external scheduler (Vercel Cron → GET /jobs/run) drives the
 * sweeps instead. Services register their sweep here regardless of the mode.
 */
export const backgroundJobsEnabled = () => process.env.BACKGROUND_JOBS !== "off";

type Job = { name: string; run: () => Promise<unknown> };
const jobs: Job[] = [];
const logger = new Logger("Jobs");

export function registerJob(name: string, run: () => Promise<unknown>) {
  jobs.push({ name, run });
}

/** Run every registered sweep in turn; one failure never stops the rest. */
export async function runAllJobs() {
  const results: Record<string, "ok" | string> = {};
  for (const job of jobs) {
    const started = Date.now();
    try {
      await job.run();
      results[job.name] = "ok";
      logger.log(`${job.name} done in ${Date.now() - started}ms`);
    } catch (err) {
      results[job.name] = (err as Error).message;
      logger.warn(`${job.name} failed: ${(err as Error).message}`);
    }
  }
  return results;
}
