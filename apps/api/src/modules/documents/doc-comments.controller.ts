import { Body, Controller, Delete, Get, Param, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { DocCommentsService } from "./doc-comments.service.js";

const createSchema = z.object({ body: z.string().min(1).max(5000), quote: z.string().max(500).nullable().optional(), parentId: z.string().uuid().nullable().optional() });
const resolveSchema = z.object({ resolved: z.boolean() });

/** Row 16: comments on docs. */
@Controller("documents/:id/comments")
export class DocCommentsController {
  constructor(private readonly comments: DocCommentsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.comments.list(auth.orgId, { userId: auth.userId, role: auth.role }, id);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(createSchema))
  create(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof createSchema>) {
    return this.comments.create(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto);
  }

  @Post(":commentId/resolve")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(resolveSchema))
  resolve(@Auth() auth: AuthContext, @Param("id") id: string, @Param("commentId") commentId: string, @Body() dto: z.infer<typeof resolveSchema>) {
    return this.comments.resolve(auth.orgId, { userId: auth.userId, role: auth.role }, id, commentId, dto.resolved);
  }

  @Delete(":commentId")
  @Roles("owner", "admin", "member")
  remove(@Auth() auth: AuthContext, @Param("id") id: string, @Param("commentId") commentId: string) {
    return this.comments.remove(auth.orgId, { userId: auth.userId, role: auth.role }, id, commentId);
  }
}
