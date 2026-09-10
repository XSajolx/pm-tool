import { Body, Controller, Get, Param, Patch, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CommentsService } from "./comments.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const assignSchema = z.object({ assigneeId: z.string().uuid().nullable() });
const resolveSchema = z.object({ resolved: z.boolean() });

/** Comment creation lives under /tasks/:id/comments; this handles the rest. */
@Controller("comments")
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /** The "Assigned Comments" inbox. `?resolved=true` includes closed ones. */
  @Get("assigned")
  assigned(@Auth() auth: AuthContext, @Query("resolved") resolved?: string) {
    return this.comments.assignedToMe(auth.orgId, auth.userId, resolved === "true");
  }

  @Get("assigned/count")
  assignedCount(@Auth() auth: AuthContext) {
    return this.comments.openAssignedCount(auth.orgId, auth.userId);
  }

  @Patch(":id/assign")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(assignSchema))
  assign(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof assignSchema>,
  ) {
    return this.comments.assign(auth.orgId, auth.userId, id, dto.assigneeId);
  }

  @Patch(":id/resolve")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(resolveSchema))
  resolve(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof resolveSchema>,
  ) {
    return this.comments.resolve(auth.orgId, auth.userId, id, dto.resolved);
  }
}
