import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { MilestonesService } from "./milestones.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const isoDate = z.string().datetime();
const milestoneSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
  targetDate: isoDate.nullable().optional(),
  reachedAt: isoDate.nullable().optional(),
  clientVisible: z.boolean().optional(),
});
/** Row 75 */
const signoffRequestSchema = z.object({ approverId: z.string().uuid().optional() });
const signoffDecisionSchema = z.object({ approve: z.boolean(), note: z.string().max(2000).optional() });

@Controller()
export class MilestonesController {
  constructor(private readonly milestones: MilestonesService) {}

  @Get("projects/:projectId/milestones")
  list(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    return this.milestones.listForProject(auth.orgId, projectId);
  }

  @Get("milestones")
  forSpace(@Auth() auth: AuthContext, @Query("spaceId") spaceId?: string) {
    return spaceId ? this.milestones.listForSpace(auth.orgId, spaceId) : [];
  }

  @Post("projects/:projectId/milestones")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(milestoneSchema))
  create(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Body() dto: z.infer<typeof milestoneSchema>) {
    return this.milestones.create(auth.orgId, auth.userId, projectId, dto);
  }

  @Patch("milestones/:id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(milestoneSchema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof milestoneSchema>>) {
    return this.milestones.update(auth.orgId, auth.userId, id, dto);
  }

  /** Row 75: ask for sign-off; the approver gets an inbox card with Approve / Reject. */
  @Post("milestones/:id/signoff")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(signoffRequestSchema))
  requestSignoff(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof signoffRequestSchema>) {
    return this.milestones.requestSignoff(auth.orgId, auth.userId, id, dto.approverId);
  }

  @Post("milestones/:id/signoff/decision")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(signoffDecisionSchema))
  decideSignoff(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof signoffDecisionSchema>) {
    return this.milestones.decideSignoff(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto.approve, dto.note);
  }

  @Get("milestones/:id/activity")
  activity(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.milestones.activityFor(auth.orgId, id);
  }

  @Delete("milestones/:id")
  @Roles("owner", "admin")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.milestones.remove(auth.orgId, auth.userId, id);
  }
}
