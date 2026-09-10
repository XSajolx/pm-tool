import { Body, Controller, Get, Param, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { ReactionsService, type ReactionEntity } from "./reactions.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const toggleSchema = z.object({ emoji: z.string().min(1).max(32) });
const ENTITIES = ["task", "comment", "message"] as const;
const entitySchema = z.enum(ENTITIES);

@Controller("reactions")
export class ReactionsController {
  constructor(private readonly reactions: ReactionsService) {}

  @Get(":entityType/:entityId")
  list(
    @Auth() auth: AuthContext,
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
  ) {
    return this.reactions.forEntity(
      auth.orgId,
      auth.userId,
      entitySchema.parse(entityType) as ReactionEntity,
      entityId,
    );
  }

  /** Toggles: reacting twice with the same emoji removes it. */
  @Post(":entityType/:entityId")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(toggleSchema))
  toggle(
    @Auth() auth: AuthContext,
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body() dto: z.infer<typeof toggleSchema>,
  ) {
    return this.reactions.toggle(
      auth.orgId,
      auth.userId,
      entitySchema.parse(entityType) as ReactionEntity,
      entityId,
      dto.emoji,
    );
  }
}
