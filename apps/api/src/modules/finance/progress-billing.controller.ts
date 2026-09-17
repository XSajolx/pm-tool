import { Body, Controller, Get, Param, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ProgressBillingService } from "./progress-billing.service.js";

const draftSchema = z.object({ projectId: z.string().uuid(), stageIds: z.array(z.string().uuid()).max(100).nullable().optional(), title: z.string().max(255).nullable().optional() });

/** Row 137: progress invoices from stage % complete. */
@Controller("finance/progress")
@Roles("owner", "admin")
export class ProgressBillingController {
  constructor(private readonly progress: ProgressBillingService) {}

  @Get(":projectId")
  forProject(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    return this.progress.forProject(auth.orgId, projectId);
  }

  @Post("draft")
  @UsePipes(new ZodValidationPipe(draftSchema))
  draft(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof draftSchema>) {
    return this.progress.draft(auth.orgId, auth.userId, dto);
  }
}
