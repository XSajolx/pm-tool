import { Body, Controller, Delete, Get, Param, Patch, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { TemplatesService } from "./templates.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const fromListSchema = z.object({
  listId: z.string().uuid(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
});
const updateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).nullable().optional(),
});
const applySchema = z.object({
  projectId: z.string().uuid(),
  listId: z.string().uuid().optional(),
});

@Controller("task-templates")
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.templates.list(auth.orgId);
  }

  @Post("from-list")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(fromListSchema))
  fromList(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof fromListSchema>) {
    return this.templates.createFromList(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(updateSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof updateSchema>) {
    return this.templates.update(auth.orgId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.templates.remove(auth.orgId, id);
  }

  @Post(":id/apply")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(applySchema))
  apply(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof applySchema>) {
    return this.templates.apply(auth.orgId, auth.userId, id, dto);
  }

  @Get("project-lists/:projectId")
  projectLists(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    return this.templates.listsForProject(auth.orgId, projectId);
  }
}
