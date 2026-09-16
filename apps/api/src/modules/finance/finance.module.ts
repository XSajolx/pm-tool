import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { InvoicesController } from "./invoices.controller.js";
import { PublicInvoicesController } from "./public-invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";
import { SchedulesController } from "./schedules.controller.js";
import { SchedulesService } from "./schedules.service.js";

/**
 * Money: invoices now (row 156); recurring billing, expenses, P&L, Profit
 * First buckets and tax estimates (rows 157-164) will join this module.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [InvoicesController, PublicInvoicesController, SchedulesController],
  providers: [InvoicesService, SchedulesService],
  exports: [InvoicesService, SchedulesService],
})
export class FinanceModule {}
