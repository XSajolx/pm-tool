import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UsePipes } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { InvoicesService } from "./invoices.service.js";

const itemSchema = z.object({
  description: z.string().min(1).max(2000),
  quantity: z.number().nonnegative(),
  unitPrice: z.number(),
  stageId: z.string().uuid().nullable().optional(),
  billedPct: z.number().int().min(0).max(100).nullable().optional(),
});

const writeSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).optional(),
  issueDate: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  items: z.array(itemSchema).max(200).optional(),
});

const createSchema = writeSchema.extend({
  fromEstimateId: z.string().uuid().nullable().optional(),
  fromProposalId: z.string().uuid().nullable().optional(),
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["bank_transfer", "card", "cash", "cheque", "other"]).optional(),
  paidAt: z.string().datetime().nullable().optional(),
  reference: z.string().max(255).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const voidSchema = z.object({ reason: z.string().max(500).nullable().optional() });
const onlineSchema = z.object({ enabled: z.boolean() });
const reviseSchema = z.object({ reason: z.string().min(1).max(500) });
const returnSchema = z.object({ note: z.string().max(500).nullable().optional() });
const settingsSchema = z.object({
  prefix: z.string().max(12).optional(),
  padding: z.number().int().min(1).max(8).optional(),
  nextNumber: z.number().int().min(1).nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).optional(),
  defaultTaxRate: z.number().min(0).max(100).optional(),
  defaultCurrency: z.string().length(3).optional(),
  defaultNotes: z.string().max(5000).optional(),
  requireReview: z.boolean().optional(),
});

/** Row 156. Members can draft; issuing, money and voiding are owner/admin work. */
@Controller("finance/invoices")
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("status") status?: string, @Query("companyId") companyId?: string, @Query("projectId") projectId?: string) {
    return this.invoices.list(auth.orgId, { status, companyId, projectId });
  }

  @Get("summary")
  summary(@Auth() auth: AuthContext) {
    return this.invoices.summary(auth.orgId);
  }

  /* row 139 */
  @Get("settings")
  settings(@Auth() auth: AuthContext) {
    return this.invoices.settings(auth.orgId);
  }

  @Patch("settings")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(settingsSchema))
  updateSettings(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof settingsSchema>) {
    return this.invoices.updateSettings(auth.orgId, auth.userId, dto);
  }

  @Get(":id/versions")
  versions(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.invoices.versions(auth.orgId, id);
  }

  @Post(":id/submit")
  @Roles("owner", "admin", "member")
  submit(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.invoices.submitForReview(auth.orgId, auth.userId, id);
  }

  @Post(":id/return")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(returnSchema))
  returnToDraft(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof returnSchema>) {
    return this.invoices.returnToDraft(auth.orgId, auth.userId, id, dto.note);
  }

  @Post(":id/revise")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(reviseSchema))
  revise(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof reviseSchema>) {
    return this.invoices.revise(auth.orgId, auth.userId, id, dto.reason);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.invoices.get(auth.orgId, id);
  }

  @Get(":id/pdf")
  async pdf(@Auth() auth: AuthContext, @Param("id") id: string, @Res() res: Response) {
    const { bytes, filename } = await this.invoices.pdf(auth.orgId, id);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(createSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof createSchema>) {
    return this.invoices.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(writeSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof writeSchema>) {
    return this.invoices.update(auth.orgId, auth.userId, id, dto);
  }

  @Post(":id/send")
  @Roles("owner", "admin")
  send(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.invoices.send(auth.orgId, auth.userId, id);
  }

  @Post(":id/reopen")
  @Roles("owner", "admin")
  reopen(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.invoices.reopen(auth.orgId, auth.userId, id);
  }

  @Post(":id/void")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(voidSchema))
  void(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof voidSchema>) {
    return this.invoices.void(auth.orgId, auth.userId, id, dto.reason);
  }

  @Post(":id/payments")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(paymentSchema))
  pay(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof paymentSchema>) {
    return this.invoices.recordPayment(auth.orgId, auth.userId, id, dto);
  }

  /** Row 129 */
  @Patch(":id/online-payments")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(onlineSchema))
  onlinePayments(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof onlineSchema>) {
    return this.invoices.setOnlinePayments(auth.orgId, auth.userId, id, dto.enabled);
  }

  @Delete(":id/payments/:paymentId")
  @Roles("owner", "admin")
  unpay(@Auth() auth: AuthContext, @Param("id") id: string, @Param("paymentId") paymentId: string) {
    return this.invoices.removePayment(auth.orgId, auth.userId, id, paymentId);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.invoices.archive(auth.orgId, auth.userId, id);
  }
}
