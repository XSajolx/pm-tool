import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { ProjectsService } from "./projects.service.js";
import { ProjectAccessService } from "../access/project-access.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const projectSchema = z.object({
  name: z.string().min(1).max(255),
  clientName: z.string().max(255).nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  description: z.string().max(20_000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status: z.enum(["active", "on_hold", "completed", "archived"]).optional(),
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
  budgetHours: z.number().int().nonnegative().optional(),
  budgetAmount: z.number().nonnegative().optional(),
  hourlyRate: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  spaceId: z.string().uuid().optional(),
});

const updateSchema = projectSchema.partial().omit({ spaceId: true });
/** Row 85 */
const memberRoleSchema = z.object({ role: z.enum(["lead", "contributor", "viewer"]) });

@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get()
  async list(@Auth() auth: AuthContext, @Query("archived") archived?: string) {
    // Row 84: team members and guests only see the projects they're on.
    const rows = await this.projects.list(auth.orgId, archived === "true");
    const visible = await this.access.visibleProjectIds(auth.orgId, auth);
    return visible ? rows.filter((p) => visible.has(p.id)) : rows;
  }

  @Get(":id")
  async get(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.access.assertProject(auth.orgId, auth, id);
    return this.projects.get(auth.orgId, id);
  }

  /** Projects are commercial containers, so creating one is admin work. */
  @Post()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(projectSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof projectSchema>) {
    return this.projects.create(auth.orgId, auth.userId, dto);
  }

  /** Row 85: admins and the project's leads can edit the project. */
  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(updateSchema))
  async update(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof updateSchema>,
  ) {
    await this.access.assertCanManage(auth.orgId, auth, id);
    return this.projects.update(auth.orgId, auth.userId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.projects.archive(auth.orgId, auth.userId, id);
  }

  /* Row 39: project team (mirrored into the project channel). */
  @Get(":id/members")
  async members(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.access.assertProject(auth.orgId, auth, id);
    return this.projects.members(auth.orgId, id);
  }

  @Post(":id/members")
  @Roles("owner", "admin", "member")
  async addMembers(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: { userIds: string[] }) {
    await this.access.assertCanManage(auth.orgId, auth, id);
    return this.projects.addMembers(auth.orgId, auth.userId, id, body.userIds ?? []);
  }

  /** Row 85: lead / contributor / viewer on this project. */
  @Patch(":id/members/:userId/role")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(memberRoleSchema))
  async setMemberRole(@Auth() auth: AuthContext, @Param("id") id: string, @Param("userId") userId: string, @Body() dto: z.infer<typeof memberRoleSchema>) {
    await this.access.assertCanManage(auth.orgId, auth, id);
    return this.projects.setMemberRole(auth.orgId, auth.userId, id, userId, dto.role);
  }

  @Delete(":id/members/:userId")
  @Roles("owner", "admin", "member")
  async removeMember(@Auth() auth: AuthContext, @Param("id") id: string, @Param("userId") userId: string) {
    await this.access.assertCanManage(auth.orgId, auth, id);
    return this.projects.removeMember(auth.orgId, auth.userId, id, userId);
  }
}
