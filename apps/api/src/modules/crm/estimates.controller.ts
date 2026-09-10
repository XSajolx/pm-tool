import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { EstimatesService, type EstimateStatus } from "./estimates.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const itemSchema = z.object({
  description: z.string().min(1).max(2000),
  quantity: z.number().nonnegative(),
  unitPrice: z.number(),
});

const schema = z.object({
  title: z.string().min(1).max(255),
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).optional(),
  issueDate: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  items: z.array(itemSchema).max(200).optional(),
});

const statusSchema = z.object({
  status: z.enum(["draft", "sent", "accepted", "declined", "expired"]),
});

@Controller("crm/estimates")
export class EstimatesController {
  constructor(private readonly estimates: EstimatesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("companyId") companyId?: string, @Query("dealId") dealId?: string) {
    return this.estimates.list(auth.orgId, { companyId, dealId });
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.estimates.get(auth.orgId, id);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    return this.estimates.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof schema>>) {
    return this.estimates.update(auth.orgId, auth.userId, id, dto);
  }

  @Patch(":id/status")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(statusSchema))
  setStatus(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof statusSchema>) {
    return this.estimates.setStatus(auth.orgId, auth.userId, id, dto.status as EstimateStatus);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.estimates.archive(auth.orgId, auth.userId, id);
  }
}
