import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { InvoicesController } from "./invoices.controller.js";
import { PublicInvoicesController, StripeWebhookController } from "./public-invoices.controller.js";
import { StripeService } from "./stripe.service.js";
import { ContractorsController } from "./contractors.controller.js";
import { ContractorsService } from "./contractors.service.js";
import { InvoicesService } from "./invoices.service.js";
import { SchedulesController } from "./schedules.controller.js";
import { SchedulesService } from "./schedules.service.js";
import { ExpensesController } from "./expenses.controller.js";
import { ExpensesService } from "./expenses.service.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsService } from "./reports.service.js";
import { ProfitFirstController } from "./profit-first.controller.js";
import { ProfitFirstService } from "./profit-first.service.js";
import { TaxController } from "./tax.controller.js";
import { TaxService } from "./tax.service.js";
import { FinanceOverviewController } from "./finance-overview.controller.js";
import { FinanceOverviewService } from "./finance-overview.service.js";

/**
 * Money: invoices now (row 156); recurring billing, expenses, P&L, Profit
 * First buckets and tax estimates (rows 157-164) will join this module.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [InvoicesController, PublicInvoicesController, StripeWebhookController, SchedulesController, ExpensesController, ReportsController, ProfitFirstController, TaxController, FinanceOverviewController, ContractorsController],
  providers: [InvoicesService, StripeService, SchedulesService, ExpensesService, ReportsService, ProfitFirstService, TaxService, FinanceOverviewService, ContractorsService],
  exports: [InvoicesService, StripeService, SchedulesService, ExpensesService, ProfitFirstService],
})
export class FinanceModule {}
