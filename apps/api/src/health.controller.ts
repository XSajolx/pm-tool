import { Controller, Get } from "@nestjs/common";
import { Public } from "./modules/auth/auth.decorators.js";

@Controller("health")
export class HealthController {
  /** Unauthenticated on purpose — load balancers and uptime checks probe this. */
  @Public()
  @Get()
  check() {
    return { status: "ok", ts: new Date().toISOString() };
  }
}
