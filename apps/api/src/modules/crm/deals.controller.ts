import { Body, Controller, Delete, Get, Param, Patch, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { DealsService } from "./deals.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const stageSchema = z.enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"]);

const schema = z.object({
  title: z.string().min(1).max(255),
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  stage: stageSchema.optional(),
  probability: z.number().int().min(0).max(100).optional(),
  expectedCloseDate: z.string().datetime().nullable().optional(),
  lostReason: z.string().max(2000).nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
});

const moveSchema = z.object({ stage: stageSchema, position: z.number() });

@Controller("crm/deals")
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.deals.list(auth.orgId);
  }

  /** Grouped by stage with totals — what the pipeline view renders. */
  @Get("board")
  board(@Auth() auth: AuthContext) {
    return this.deals.board(auth.orgId);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.deals.get(auth.orgId, id);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    return this.deals.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof schema>>) {
    return this.deals.update(auth.orgId, auth.userId, id, dto);
  }

  @Patch(":id/move")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(moveSchema))
  move(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof moveSchema>) {
    return this.deals.move(auth.orgId, auth.userId, id, dto.stage, dto.position);
  }

  /** Won → Project. Creating projects is admin work, so this is too. */
  @Post(":id/convert")
  @Roles("owner", "admin")
  convert(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.deals.convertToProject(auth.orgId, auth.userId, id);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.deals.archive(auth.orgId, auth.userId, id);
  }
}
