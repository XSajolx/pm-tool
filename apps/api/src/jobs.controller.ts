import { Controller, Get, Headers, UnauthorizedException, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "./modules/auth/auth.decorators.js";
import { runAllJobs } from "./common/jobs.js";

/**
 * External trigger for the background sweeps when the in-process timers are off
 * (serverless). Vercel Cron issues a GET and sends `Authorization: Bearer $CRON_SECRET` on its own;
 * anything else needs the same header.
 */
@Controller("jobs")
export class JobsController {
  @Public()
  @Get("run")
  async run(@Headers("authorization") authorization?: string) {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new ServiceUnavailableException("CRON_SECRET is not configured");
    if (authorization !== `Bearer ${secret}`) throw new UnauthorizedException();
    return { ran: await runAllJobs(), ts: new Date().toISOString() };
  }
}
