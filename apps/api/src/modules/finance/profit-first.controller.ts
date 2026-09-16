import { Body, Controller, Delete, Get, Param, Patch, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ProfitFirstService, type Bucket } from "./profit-first.service.js";

const bucket = z.enum(["profit", "owner_pay", "tax", "opex"]);
const configSchema = z.object({
  enabled: z.boolean().optional(),
  startedAt: z.string().max(10).nullable().optional(),
  buckets: z.array(z.object({ key: bucket, label: z.string().max(40).optional(), currentPct: z.number().min(0).max(100).optional(), targetPct: z.number().min(0).max(100).optional() })).max(4).optional(),
});
const manualSchema = z.object({ amount: z.number().positive(), date: z.string().max(30).nullable().optional(), note: z.string().max(500).nullable().optional() });
const moveSchema = z.object({ bucket, amount: z.number().positive(), date: z.string().max(30).nullable().optional(), note: z.string().max(500).nullable().optional(), kind: z.enum(["distribution", "adjustment"]).optional(), direction: z.enum(["in", "out"]).optional() });
const transferSchema = z.object({ transferred: z.boolean() });

/** Row 162. Owner/admin only — this is the owner's money plan. */
@Controller("finance/profit-first")
export class ProfitFirstController {
  constructor(private readonly pf: ProfitFirstService) {}

  @Get()
  @Roles("owner", "admin")
  overview(@Auth() auth: AuthContext) {
    return this.pf.overview(auth.orgId);
  }

  @Patch("config")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(configSchema))
  config(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof configSchema>) {
    return this.pf.updateConfig(auth.orgId, auth.userId, dto as Parameters<ProfitFirstService["updateConfig"]>[2]);
  }

  @Post("allocate")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(manualSchema))
  allocate(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof manualSchema>) {
    return this.pf.allocateManual(auth.orgId, auth.userId, dto);
  }

  @Post("backfill")
  @Roles("owner", "admin")
  backfill(@Auth() auth: AuthContext) {
    return this.pf.backfill(auth.orgId, auth.userId);
  }

  @Post("movements")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(moveSchema))
  move(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof moveSchema>) {
    return this.pf.distribute(auth.orgId, auth.userId, { ...dto, bucket: dto.bucket as Bucket });
  }

  @Delete("movements/:id")
  @Roles("owner", "admin")
  removeMovement(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.pf.removeMovement(auth.orgId, auth.userId, id);
  }

  @Patch("allocations/:groupId/transferred")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(transferSchema))
  transferred(@Auth() auth: AuthContext, @Param("groupId") groupId: string, @Body() dto: z.infer<typeof transferSchema>) {
    return this.pf.setTransferred(auth.orgId, auth.userId, groupId, dto.transferred);
  }

  @Delete("allocations/:groupId")
  @Roles("owner", "admin")
  removeAllocation(@Auth() auth: AuthContext, @Param("groupId") groupId: string) {
    return this.pf.removeManualAllocation(auth.orgId, auth.userId, groupId);
  }

  @Post("allocations/transfer-all")
  @Roles("owner", "admin")
  transferAll(@Auth() auth: AuthContext) {
    return this.pf.markAllTransferred(auth.orgId, auth.userId);
  }
}
