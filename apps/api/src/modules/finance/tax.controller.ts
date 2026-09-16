import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { TaxService } from "./tax.service.js";

const settingsSchema = z.object({
  jurisdictions: z.array(z.object({ key: z.string().max(40).optional(), label: z.string().max(60), ratePct: z.number().min(0).max(100) })).max(8).optional(),
  basis: z.enum(["net", "income"]).optional(),
  deductionPct: z.number().min(0).max(100).optional(),
  dueDates: z.array(z.object({ q: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) })).max(4).optional(),
  reminderDaysBefore: z.number().int().min(0).max(90).optional(),
  enabled: z.boolean().optional(),
});
const paymentSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  quarter: z.number().int().min(1).max(4),
  jurisdiction: z.string().max(40).nullable().optional(),
  amount: z.number().positive(),
  paidAt: z.string().max(30).nullable().optional(),
  reference: z.string().max(255).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

/** Row 163. Owner/admin only. */
@Controller("finance/tax")
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Get()
  @Roles("owner", "admin")
  year(@Auth() auth: AuthContext, @Query("year") year?: string) {
    const y = year ? Number(year) : undefined;
    return this.tax.year(auth.orgId, y && Number.isFinite(y) ? y : undefined);
  }

  @Patch("settings")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(settingsSchema))
  settings(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof settingsSchema>) {
    return this.tax.updateSettings(auth.orgId, auth.userId, dto);
  }

  @Post("payments")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(paymentSchema))
  pay(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof paymentSchema>) {
    return this.tax.recordPayment(auth.orgId, auth.userId, dto);
  }

  @Delete("payments/:id")
  @Roles("owner", "admin")
  unpay(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.tax.removePayment(auth.orgId, auth.userId, id);
  }

  /** Force the reminder pass (the timer runs it hourly). */
  @Post("sweep")
  @Roles("owner", "admin")
  sweep() {
    return this.tax.sweep();
  }
}
