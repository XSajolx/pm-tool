import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ExpensesService } from "./expenses.service.js";

const kind = z.enum(["expense", "refund"]);
const expenseSchema = z.object({
  date: z.string().max(30).optional(),
  vendor: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  amount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  kind: kind.optional(),
  category: z.string().max(64).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  billable: z.boolean().optional(),
  personal: z.boolean().optional(),
  receiptUrl: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  account: z.string().max(120).nullable().optional(),
  reference: z.string().max(255).nullable().optional(),
});
const updateSchema = expenseSchema.extend({ rememberVendor: z.boolean().optional(), applyToSimilar: z.boolean().optional() });
const decisionSchema = z.object({ note: z.string().max(2000).nullable().optional() });
const adjustSchema = z.object({ amount: z.number().min(0), note: z.string().min(1).max(2000) });
const ruleSchema = z.object({
  match: z.string().min(2).max(255),
  category: z.string().max(64).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  billable: z.boolean().nullable().optional(),
  personal: z.boolean().nullable().optional(),
});
const previewSchema = z.object({ text: z.string().min(1).max(5_000_000) });
const commitSchema = z.object({
  filename: z.string().min(1).max(255),
  account: z.string().max(120).nullable().optional(),
  rows: z
    .array(
      z.object({
        date: z.string().max(30).nullable(),
        vendor: z.string().max(255),
        description: z.string().max(2000).nullable().optional(),
        amount: z.number(),
        kind: kind.optional(),
        currency: z.string().max(3).nullable().optional(),
        reference: z.string().max(255).nullable().optional(),
        category: z.string().max(64).nullable().optional(),
        projectId: z.string().uuid().nullable().optional(),
        billable: z.boolean().optional(),
        personal: z.boolean().optional(),
        skip: z.boolean().optional(),
      }),
    )
    .max(5000),
});
const addSchema = z.object({ expenseIds: z.array(z.string().uuid()).min(1).max(200), markupPercent: z.number().min(0).max(100).optional() });

/** Row 160. Everyone logs; import, rules and billing are owner/admin. */
@Controller("finance/expenses")
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query("filter") filter?: string,
    @Query("projectId") projectId?: string,
    @Query("companyId") companyId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("importId") importId?: string,
    @Query("q") q?: string,
    @Query("mine") mine?: string,
  ) {
    // Row 132: members see what they logged; the books are owner/admin.
    const own = mine === "1" || auth.role === "member";
    return this.expenses.list(auth.orgId, { filter, projectId, companyId, from, to, importId, q, createdById: own ? auth.userId : undefined });
  }

  @Get("summary")
  summary(@Auth() auth: AuthContext) {
    return this.expenses.summary(auth.orgId);
  }

  @Get("categories")
  categories() {
    return this.expenses.categories();
  }

  @Get("rules")
  rules(@Auth() auth: AuthContext) {
    return this.expenses.rules(auth.orgId);
  }

  @Post("rules")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(ruleSchema))
  createRule(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof ruleSchema>) {
    return this.expenses.createRule(auth.orgId, auth.userId, dto);
  }

  @Delete("rules/:id")
  @Roles("owner", "admin")
  removeRule(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.expenses.removeRule(auth.orgId, id);
  }

  @Get("imports")
  imports(@Auth() auth: AuthContext) {
    return this.expenses.imports(auth.orgId);
  }

  @Post("imports/preview")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(previewSchema))
  preview(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof previewSchema>) {
    return this.expenses.preview(auth.orgId, dto.text);
  }

  @Post("imports")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(commitSchema))
  commit(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof commitSchema>) {
    return this.expenses.commit(auth.orgId, auth.userId, dto);
  }

  @Delete("imports/:id")
  @Roles("owner", "admin")
  undoImport(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.expenses.undoImport(auth.orgId, auth.userId, id);
  }

  @Get("billable")
  billable(@Auth() auth: AuthContext, @Query("projectId") projectId?: string, @Query("companyId") companyId?: string) {
    return this.expenses.billableFor(auth.orgId, { projectId, companyId });
  }

  @Post("invoice/:invoiceId")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(addSchema))
  addToInvoice(@Auth() auth: AuthContext, @Param("invoiceId") invoiceId: string, @Body() dto: z.infer<typeof addSchema>) {
    return this.expenses.addToInvoice(auth.orgId, auth.userId, invoiceId, dto.expenseIds, dto.markupPercent ?? 0);
  }

  @Delete("invoice/:invoiceId/:expenseId")
  @Roles("owner", "admin")
  removeFromInvoice(@Auth() auth: AuthContext, @Param("invoiceId") invoiceId: string, @Param("expenseId") expenseId: string) {
    return this.expenses.removeFromInvoice(auth.orgId, auth.userId, invoiceId, expenseId);
  }

  /* ---- row 133: approval queue ---- */

  @Get("queue")
  queue(@Auth() auth: AuthContext) {
    return this.expenses.queue(auth.orgId, { userId: auth.userId, role: auth.role });
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.expenses.get(auth.orgId, id, auth.role === "member" ? auth.userId : undefined);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(expenseSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof expenseSchema>) {
    return this.expenses.create(auth.orgId, auth.userId, dto, auth.role);
  }

  @Post(":id/approve")
  @UsePipes(new ZodValidationPipe(decisionSchema))
  approve(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof decisionSchema>) {
    return this.expenses.decide(auth.orgId, { userId: auth.userId, role: auth.role }, id, true, dto.note);
  }

  @Post(":id/reject")
  @UsePipes(new ZodValidationPipe(decisionSchema))
  reject(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof decisionSchema>) {
    return this.expenses.decide(auth.orgId, { userId: auth.userId, role: auth.role }, id, false, dto.note);
  }

  @Post(":id/resubmit")
  @Roles("owner", "admin", "member")
  resubmit(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.expenses.resubmit(auth.orgId, auth.userId, id, auth.role === "member" ? auth.userId : undefined);
  }

  @Post(":id/adjust")
  @UsePipes(new ZodValidationPipe(adjustSchema))
  adjust(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof adjustSchema>) {
    return this.expenses.adjust(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(updateSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof updateSchema>) {
    return this.expenses.update(auth.orgId, auth.userId, id, dto, auth.role === "member" ? auth.userId : undefined);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.expenses.remove(auth.orgId, auth.userId, id);
  }
}
