import { Body, Controller, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { IntakeService, type IntakeDecision } from "./intake.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const ensureSchema = z.object({
  spaceId: z.string().uuid(),
  targetListId: z.string().uuid().optional(),
});

const submitSchema = z.object({
  intakeId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).optional(),
  source: z.enum(["in_app", "email", "form"]).optional(),
  sourceEmail: z.string().email().optional(),
});

const decideSchema = z.object({
  decision: z.enum(["accepted", "rejected", "snoozed", "duplicate"]),
  snoozedTill: z.string().datetime().optional(),
  duplicateToTaskId: z.string().uuid().optional(),
  statusId: z.string().uuid().optional(),
});

@Controller("intake")
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("spaceId") spaceId: string) {
    return this.intake.listForSpace(auth.orgId, spaceId);
  }

  @Post()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(ensureSchema))
  ensure(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof ensureSchema>) {
    return this.intake.ensureForSpace(auth.orgId, dto.spaceId, dto.targetListId);
  }

  @Get(":id/items")
  items(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Query("status") status?: string,
  ) {
    return this.intake.items(auth.orgId, id, status);
  }

  /** Anyone in the org can submit - that is the point of a suggestion box. */
  @Post("submit")
  @UsePipes(new ZodValidationPipe(submitSchema))
  submit(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof submitSchema>) {
    return this.intake.submit(auth.orgId, auth.userId, dto);
  }

  /** Triaging is a moderation action, so members cannot do it. */
  @Patch("items/:itemId")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(decideSchema))
  decide(
    @Auth() auth: AuthContext,
    @Param("itemId") itemId: string,
    @Body() dto: z.infer<typeof decideSchema>,
  ) {
    return this.intake.decide(
      auth.orgId,
      auth.userId,
      itemId,
      dto.decision as IntakeDecision,
      dto,
    );
  }
}
