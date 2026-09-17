import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ContractorsService } from "./contractors.service.js";

const contractorSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().max(320).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  company: z.string().max(255).nullable().optional(),
  role: z.string().max(120).nullable().optional(),
  defaultRate: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(5000).nullable().optional(),
  active: z.boolean().optional(),
});
const engageSchema = z.object({
  contractorId: z.string().uuid().nullable().optional(),
  name: z.string().max(255).nullable().optional(),
  email: z.string().email().max(320).nullable().optional(),
  role: z.string().max(120).nullable().optional(),
  agreedAmount: z.number().min(0).nullable().optional(),
  agreedRate: z.number().min(0).nullable().optional(),
  markupPct: z.number().min(0).max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
const invoiceSchema = z.object({
  projectId: z.string().uuid(),
  ref: z.string().max(64).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  amount: z.number().positive(),
  currency: z.string().length(3).optional(),
  date: z.string().max(30).nullable().optional(),
  dueDate: z.string().max(30).nullable().optional(),
  markupPct: z.number().min(0).max(500).nullable().optional(),
  billable: z.boolean().optional(),
  receiptUrl: z.string().max(2000).nullable().optional(),
  paid: z.boolean().optional(),
});
const paidSchema = z.object({ paid: z.boolean(), paidAt: z.string().max(30).nullable().optional(), reference: z.string().max(255).nullable().optional() });

/** Row 135. Everyone can see who is engaged; managing people and money is owner/admin or the project lead. */
@Controller("finance/contractors")
export class ContractorsController {
  constructor(private readonly contractors: ContractorsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("all") all?: string) {
    return this.contractors.list(auth.orgId, all === "1");
  }

  @Post()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(contractorSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof contractorSchema>) {
    return this.contractors.create(auth.orgId, auth, dto);
  }

  /* project engagements (declared before :id) */
  @Get("project/:projectId")
  forProject(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    return this.contractors.forProject(auth.orgId, projectId);
  }

  @Post("project/:projectId")
  @UsePipes(new ZodValidationPipe(engageSchema))
  engage(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Body() dto: z.infer<typeof engageSchema>) {
    return this.contractors.engage(auth.orgId, auth, projectId, dto);
  }

  @Patch("project/:projectId/:engagementId")
  @UsePipes(new ZodValidationPipe(engageSchema))
  updateEngagement(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Param("engagementId") id: string, @Body() dto: z.infer<typeof engageSchema>) {
    return this.contractors.updateEngagement(auth.orgId, auth, projectId, id, dto);
  }

  @Delete("project/:projectId/:engagementId")
  disengage(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Param("engagementId") id: string) {
    return this.contractors.disengage(auth.orgId, auth, projectId, id);
  }

  @Post("invoices/:expenseId/paid")
  @UsePipes(new ZodValidationPipe(paidSchema))
  paid(@Auth() auth: AuthContext, @Param("expenseId") expenseId: string, @Body() dto: z.infer<typeof paidSchema>) {
    return this.contractors.markPaid(auth.orgId, auth, expenseId, dto);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.contractors.get(auth.orgId, id);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(contractorSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof contractorSchema>) {
    return this.contractors.update(auth.orgId, auth, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.contractors.archive(auth.orgId, auth, id);
  }

  /** Any member can log an invoice they received; it waits for approval unless they manage the project. */
  @Post(":id/invoices")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(invoiceSchema))
  logInvoice(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof invoiceSchema>) {
    return this.contractors.logInvoice(auth.orgId, auth, id, dto);
  }
}
