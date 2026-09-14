import { Body, Controller, Delete, Get, Param, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ProjectAccessService } from "../access/project-access.service.js";
import { LinkedFilesService, type LinkedEntity } from "./linked-files.service.js";

const entity = z.enum(["task", "document", "project", "contact", "company"]);
const addSchema = z.object({ entityType: entity, entityId: z.string().uuid(), url: z.string().min(8).max(2000), name: z.string().max(255).nullable().optional() });

/** Row 124: Drive / Dropbox links on tasks, docs, projects, contacts and companies. */
@Controller("linked-files")
export class LinkedFilesController {
  constructor(
    private readonly files: LinkedFilesService,
    private readonly access: ProjectAccessService,
  ) {}

  private async guard(auth: AuthContext, entityType: LinkedEntity, entityId: string) {
    if (entityType === "task") await this.access.assertTask(auth.orgId, auth, entityId);
    if (entityType === "project") await this.access.assertProject(auth.orgId, auth, entityId);
  }

  @Get()
  async list(@Auth() auth: AuthContext, @Query("entityType") entityType: string, @Query("entityId") entityId: string) {
    const type = entity.parse(entityType);
    await this.guard(auth, type, entityId);
    return this.files.list(auth.orgId, type, entityId);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(addSchema))
  async add(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof addSchema>) {
    await this.guard(auth, dto.entityType, dto.entityId);
    return this.files.add(auth.orgId, auth.userId, dto);
  }

  @Post(":id/refresh")
  @Roles("owner", "admin", "member")
  refresh(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.files.refresh(auth.orgId, id);
  }

  @Delete(":id")
  @Roles("owner", "admin", "member")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.files.remove(auth.orgId, id);
  }
}
