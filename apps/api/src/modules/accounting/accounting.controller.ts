import { Body, Controller, Get, Param, Patch, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { AccountingService } from "./accounting.service.js";

const settingsSchema = z.object({
  provider: z.enum(["quickbooks", "xero", "demo"]).nullable().optional(),
  autoSync: z.boolean().optional(),
  syncPayments: z.boolean().optional(),
  xeroSalesAccountCode: z.string().max(20).optional(),
  xeroPaymentAccountCode: z.string().max(20).optional(),
  quickbooksItemName: z.string().min(1).max(100).optional(),
});
const resolveSchema = z.object({ choice: z.enum(["ours", "theirs", "retry"]) });
const syncSchema = z.object({ invoiceId: z.string().uuid().optional() });
const demoEditSchema = z.object({ patch: z.record(z.unknown()) });

/** Row 131: accounting sync. Everything here is owner/admin — it is the books. */
@Controller("finance/accounting")
@Roles("owner", "admin")
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Get()
  overview(@Auth() auth: AuthContext) {
    return this.accounting.overview(auth.orgId);
  }

  @Patch("settings")
  @UsePipes(new ZodValidationPipe(settingsSchema))
  settings(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof settingsSchema>) {
    return this.accounting.updateSettings(auth.orgId, auth.userId, dto);
  }

  @Post("sync")
  @UsePipes(new ZodValidationPipe(syncSchema))
  sync(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof syncSchema>) {
    return this.accounting.run(auth.orgId, "manual", auth.userId, dto.invoiceId ? { invoiceId: dto.invoiceId } : undefined);
  }

  @Get("invoices/:invoiceId")
  forInvoice(@Auth() auth: AuthContext, @Param("invoiceId") invoiceId: string) {
    return this.accounting.forInvoice(auth.orgId, invoiceId);
  }

  @Post("links/:id/resolve")
  @UsePipes(new ZodValidationPipe(resolveSchema))
  resolve(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof resolveSchema>) {
    return this.accounting.resolve(auth.orgId, auth.userId, id, dto.choice);
  }

  /** Demo ledger only: look at the fake books and simulate an edit made over there. */
  @Get("demo")
  demo(@Auth() auth: AuthContext) {
    return this.accounting.demoRecords(auth.orgId);
  }

  @Post("demo/:remoteId/edit")
  @UsePipes(new ZodValidationPipe(demoEditSchema))
  demoEdit(@Auth() auth: AuthContext, @Param("remoteId") remoteId: string, @Body() dto: z.infer<typeof demoEditSchema>) {
    return this.accounting.demoEdit(auth.orgId, remoteId, dto.patch);
  }
}
