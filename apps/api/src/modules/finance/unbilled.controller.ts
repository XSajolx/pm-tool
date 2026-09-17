import { Body, Controller, Get, Param, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { UnbilledService } from "./unbilled.service.js";

const draftSchema = z.object({
  projectId: z.string().uuid(),
  through: z.string().max(30).nullable().optional(),
  onlyApprovedHours: z.boolean().optional(),
  groupBy: z.enum(["person", "task", "single"]).optional(),
  includeExpenses: z.boolean().optional(),
  timeEntryIds: z.array(z.string().uuid()).max(2000).nullable().optional(),
  expenseIds: z.array(z.string().uuid()).max(500).nullable().optional(),
  title: z.string().max(255).nullable().optional(),
});

/** Row 136 (+144): unbilled work and the draft invoice built from it. Money = owner/admin. */
@Controller("finance/unbilled")
@Roles("owner", "admin")
export class UnbilledController {
  constructor(private readonly unbilled: UnbilledService) {}

  @Get()
  summary(@Auth() auth: AuthContext, @Query("onlyApproved") onlyApproved?: string) {
    return this.unbilled.summary(auth.orgId, { onlyApprovedHours: onlyApproved !== "0" });
  }

  @Get(":projectId")
  forProject(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Query("through") through?: string, @Query("onlyApproved") onlyApproved?: string) {
    return this.unbilled.forProject(auth.orgId, projectId, { through: through || null, onlyApprovedHours: onlyApproved !== "0" });
  }

  @Post("draft")
  @UsePipes(new ZodValidationPipe(draftSchema))
  draft(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof draftSchema>) {
    return this.unbilled.draft(auth.orgId, auth.userId, dto);
  }
}
