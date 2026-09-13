import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { ViewsService } from "./views.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const createSchema = z.object({
  name: z.string().min(1).max(128),
  listId: z.string().uuid().optional(),
  spaceId: z.string().uuid().optional(),
  layout: z.enum(["list", "board", "table", "calendar"]).optional(),
  filters: z.record(z.unknown()),
  isShared: z.boolean().optional(),
});

const updateSchema = createSchema.partial().omit({ listId: true, spaceId: true });

@Controller("views")
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("listId") listId?: string) {
    return this.views.listFor(auth.orgId, auth.userId, listId);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(createSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof createSchema>) {
    return this.views.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(updateSchema))
  update(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof updateSchema>,
  ) {
    return this.views.update(auth.orgId, auth.userId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin", "member")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.views.remove(auth.orgId, auth.userId, id);
  }
}
