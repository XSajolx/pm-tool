import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { StagesService } from "./stages.service.js";
import { ProjectAccessService } from "../access/project-access.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const nameSchema = z.object({ name: z.string().min(1).max(120) });
const orderSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
const applySchema = z.object({ templateId: z.string().uuid() });
const stagePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /** Row 137 */
  feeAmount: z.number().min(0).nullable().optional(),
  status: z.enum(["not_started", "active", "completed"]).optional(),
  /** Required when reopening a completed stage. */
  note: z.string().max(500).optional(),
});
/** Row 105 */
const progressSchema = z.object({ pct: z.number().int().min(0).max(100), note: z.string().max(500).optional() });
const templateSchema = z.object({
  name: z.string().min(1).max(120),
  stages: z.array(z.string().min(1).max(120)).min(1).max(30),
  isDefault: z.boolean().optional(),
});

@Controller()
export class StagesController {
  constructor(
    private readonly stages: StagesService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get("projects/:projectId/stages")
  async list(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    await this.access.assertProject(auth.orgId, auth, projectId);
    return this.stages.listForProject(auth.orgId, projectId);
  }

  /** Stages of the project that owns a space — what a task picker needs. */
  @Get("stages")
  forSpace(@Auth() auth: AuthContext, @Query("spaceId") spaceId?: string) {
    return spaceId ? this.stages.listForSpace(auth.orgId, spaceId) : [];
  }

  @Post("projects/:projectId/stages")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(nameSchema))
  create(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Body() dto: z.infer<typeof nameSchema>) {
    return this.stages.create(auth.orgId, auth.userId, projectId, dto.name);
  }

  @Put("projects/:projectId/stages/order")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(orderSchema))
  reorder(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Body() dto: z.infer<typeof orderSchema>) {
    return this.stages.reorder(auth.orgId, projectId, dto.ids);
  }

  @Post("projects/:projectId/stages/apply-template")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(applySchema))
  applyTemplate(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Body() dto: z.infer<typeof applySchema>) {
    return this.stages.applyTemplate(auth.orgId, auth.userId, projectId, dto.templateId);
  }

  @Patch("stages/:id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(stagePatchSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof stagePatchSchema>) {
    return this.stages.update(auth.orgId, auth.userId, id, dto);
  }

  /** Row 105: hand-set percent complete, with a note when it drops. */
  @Patch("stages/:id/progress")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(progressSchema))
  setProgress(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof progressSchema>) {
    return this.stages.setProgress(auth.orgId, auth.userId, id, dto.pct, dto.note);
  }

  @Get("stages/:id/progress")
  progressHistory(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.stages.progressHistory(auth.orgId, id);
  }

  @Get("stages/:id/activity")
  activity(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.stages.activityFor(auth.orgId, id);
  }

  @Delete("stages/:id")
  @Roles("owner", "admin")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.stages.remove(auth.orgId, auth.userId, id);
  }

  /* ---- templates ---- */

  @Get("stage-templates")
  templates(@Auth() auth: AuthContext) {
    return this.stages.listTemplates(auth.orgId);
  }

  @Post("stage-templates")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(templateSchema))
  createTemplate(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof templateSchema>) {
    return this.stages.createTemplate(auth.orgId, dto);
  }

  @Patch("stage-templates/:id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(templateSchema.partial()))
  updateTemplate(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof templateSchema>>) {
    return this.stages.updateTemplate(auth.orgId, id, dto);
  }

  @Delete("stage-templates/:id")
  @Roles("owner", "admin")
  removeTemplate(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.stages.removeTemplate(auth.orgId, id);
  }
}
