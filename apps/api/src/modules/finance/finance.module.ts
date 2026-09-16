import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { InvoicesController } from "./invoices.controller.js";
import { PublicInvoicesController } from "./public-invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";
import { SchedulesController } from "./schedules.controller.js";
import { SchedulesService } from "./schedules.service.js";
import { ExpensesController } from "./expenses.controller.js";
import { ExpensesService } from "./expenses.service.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsService } from "./reports.service.js";

/**
 * Money: invoices now (row 156); recurring billing, expenses, P&L, Profit
 * First buckets and tax estimates (rows 157-164) will join this module.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [InvoicesController, PublicInvoicesController, SchedulesController, ExpensesController, ReportsController],
  providers: [InvoicesService, SchedulesService, ExpensesService, ReportsService],
  exports: [InvoicesService, SchedulesService, ExpensesService],
})
export class FinanceModule {}
