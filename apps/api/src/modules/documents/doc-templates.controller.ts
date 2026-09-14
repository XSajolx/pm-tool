import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { DocTemplatesService } from "./doc-templates.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const schema = z.object({
  title: z.string().min(1).max(255),
  icon: z.string().max(16).nullable().optional(),
  content: z.record(z.unknown()).nullable().optional(),
  body: z.string().max(200_000).optional(),
  inKit: z.boolean().optional(),
});

/** Row 68 */
@Controller("doc-templates")
export class DocTemplatesController {
  constructor(private readonly templates: DocTemplatesService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.templates.list(auth.orgId);
  }

  @Post()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(schema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    return this.templates.create(auth.orgId, dto);
  }

  @Put("order")
  @Roles("owner", "admin")
  reorder(@Auth() auth: AuthContext, @Body() body: { ids: string[] }) {
    return this.templates.reorder(auth.orgId, body.ids ?? []);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(schema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof schema>>) {
    return this.templates.update(auth.orgId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.templates.remove(auth.orgId, id);
  }

  /** Create the kit's docs under a project (skips titles that already exist). */
  @Post("apply/:projectId")
  @Roles("owner", "admin", "member")
  apply(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Body() body: { templateIds?: string[] }) {
    return this.templates.applyKit(auth.orgId, auth.userId, projectId, { templateIds: body?.templateIds, onlyInKit: !body?.templateIds });
  }
}
