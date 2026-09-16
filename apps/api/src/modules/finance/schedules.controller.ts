import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { SchedulesService } from "./schedules.service.js";

const itemSchema = z.object({ description: z.string().min(1).max(2000), quantity: z.number().nonnegative(), unitPrice: z.number() });

const writeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  kind: z.enum(["recurring", "subscription"]).optional(),
  title: z.string().min(1).max(255).optional(),
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).optional(),
  items: z.array(itemSchema).max(200).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  dueDays: z.number().int().min(0).max(365).optional(),
  autoSend: z.boolean().optional(),
  every: z.number().int().min(1).max(52).optional(),
  unit: z.enum(["week", "month", "year"]).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  maxOccurrences: z.number().int().min(1).max(1000).nullable().optional(),
});

const createSchema = writeSchema.extend({ fromInvoiceId: z.string().uuid().nullable().optional() });

/** Row 157. Same split as invoices: members can set schedules up, owner/admin control what goes out. */
@Controller("finance/schedules")
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("companyId") companyId?: string, @Query("status") status?: string) {
    return this.schedules.list(auth.orgId, { companyId, status });
  }

  @Get("summary")
  summary(@Auth() auth: AuthContext) {
    return this.schedules.summary(auth.orgId);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.schedules.get(auth.orgId, id);
  }

  /** Force a generation pass now (the timer does this every 5 minutes). */
  @Post("sweep")
  @Roles("owner", "admin")
  async sweep() {
    await this.schedules.sweep();
    return { ok: true };
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(createSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof createSchema>) {
    return this.schedules.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(writeSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof writeSchema>) {
    return this.schedules.update(auth.orgId, auth.userId, id, dto);
  }

  @Post(":id/pause")
  @Roles("owner", "admin")
  pause(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.schedules.pause(auth.orgId, auth.userId, id);
  }

  @Post(":id/resume")
  @Roles("owner", "admin")
  resume(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.schedules.resume(auth.orgId, auth.userId, id);
  }

  @Post(":id/end")
  @Roles("owner", "admin")
  end(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.schedules.end(auth.orgId, auth.userId, id);
  }

  @Post(":id/run")
  @Roles("owner", "admin")
  run(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.schedules.runNow(auth.orgId, auth.userId, id);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.schedules.archive(auth.orgId, auth.userId, id);
  }
}
