import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { AccountingController } from "./accounting.controller.js";
import { AccountingService } from "./accounting.service.js";

/** Row 131: QuickBooks / Xero sync (plus the demo ledger). */
@Module({
  imports: [IntegrationsModule, NotificationsModule],
  controllers: [AccountingController],
  providers: [AccountingService],
  exports: [AccountingService],
})
export class AccountingModule {}
