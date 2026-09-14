import { Body, Controller, Delete, Get, Param, Patch, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { SnippetsService } from "./snippets.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const schema = z.object({
  name: z.string().min(1).max(160),
  content: z.record(z.unknown()).nullable().optional(),
  body: z.string().max(200_000).optional(),
});

/** Row 66 */
@Controller("snippets")
export class SnippetsController {
  constructor(private readonly snippets: SnippetsService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.snippets.list(auth.orgId);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.snippets.get(auth.orgId, id);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    return this.snippets.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof schema>>) {
    return this.snippets.update(auth.orgId, auth.userId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.snippets.remove(auth.orgId, id);
  }
}
