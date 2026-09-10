import { Body, Controller, Get, Param, Patch, Put, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { ResourcingService } from "./resourcing.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const allocationSchema = z.object({
  userId: z.string().uuid(),
  projectId: z.string().uuid(),
  /** Any date inside the target week. */
  weekStart: z.string().min(8),
  hours: z.number().min(0).max(168),
  note: z.string().max(500).optional(),
});

const capacitySchema = z.object({ hours: z.number().int().min(0).max(168) });

/** Planning is a management activity: everyone can read, admins write. */
@Controller("resourcing")
export class ResourcingController {
  constructor(private readonly resourcing: ResourcingService) {}

  @Get()
  board(
    @Auth() auth: AuthContext,
    @Query("from") from?: string,
    @Query("weeks") weeks?: string,
  ) {
    return this.resourcing.board(
      auth.orgId,
      from ?? new Date().toISOString(),
      weeks ? Number(weeks) : 8,
    );
  }

  @Get("allocations")
  allocations(
    @Auth() auth: AuthContext,
    @Query("userIds") userIds?: string,
    @Query("from") from?: string,
    @Query("weeks") weeks?: string,
  ) {
    return this.resourcing.allocationsFor(
      auth.orgId,
      userIds ? userIds.split(",").filter(Boolean) : [],
      from ?? new Date().toISOString(),
      weeks ? Number(weeks) : 8,
    );
  }

  @Put("allocations")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(allocationSchema))
  setAllocation(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof allocationSchema>) {
    return this.resourcing.setAllocation(auth.orgId, auth.userId, dto);
  }

  @Patch("capacity/:userId")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(capacitySchema))
  setCapacity(
    @Auth() auth: AuthContext,
    @Param("userId") userId: string,
    @Body() dto: z.infer<typeof capacitySchema>,
  ) {
    return this.resourcing.setCapacity(auth.orgId, userId, dto.hours);
  }
}
