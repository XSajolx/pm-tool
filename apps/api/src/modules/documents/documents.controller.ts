import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { DocumentsService } from "./documents.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const schema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().max(200_000).optional(),
  projectId: z.string().uuid().nullable().optional(),
});

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("projectId") projectId?: string) {
    return this.documents.list(auth.orgId, projectId);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.documents.get(auth.orgId, id);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    return this.documents.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof schema>>) {
    return this.documents.update(auth.orgId, auth.userId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin", "member")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.documents.archive(auth.orgId, { userId: auth.userId, role: auth.role }, id);
  }
}
