import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { ProjectsService } from "./projects.service.js";
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

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("archived") archived?: string) {
    return this.projects.list(auth.orgId, archived === "true");
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.projects.get(auth.orgId, id);
  }

  /** Projects are commercial containers, so creating one is admin work. */
  @Post()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(projectSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof projectSchema>) {
    return this.projects.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(updateSchema))
  update(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof updateSchema>,
  ) {
    return this.projects.update(auth.orgId, auth.userId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.projects.archive(auth.orgId, auth.userId, id);
  }
}
