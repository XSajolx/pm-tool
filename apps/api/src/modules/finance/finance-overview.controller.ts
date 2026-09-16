import { Controller, Get, Param } from "@nestjs/common";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { FinanceOverviewService } from "./finance-overview.service.js";

/** Row 164. */
@Controller("finance")
export class FinanceOverviewController {
  constructor(private readonly overview: FinanceOverviewService) {}

  @Get("companies/:companyId/billing")
  billing(@Auth() auth: AuthContext, @Param("companyId") companyId: string) {
    return this.overview.companyBilling(auth.orgId, companyId);
  }

  @Get("dashboard")
  @Roles("owner", "admin")
  dashboard(@Auth() auth: AuthContext) {
    return this.overview.dashboard(auth.orgId);
  }
}
