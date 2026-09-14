import { Module } from "@nestjs/common";
import { TimeController } from "./time.controller.js";
import { TimeService } from "./time.service.js";
import { TimeCodesService } from "./time-codes.service.js";
import { TimesheetRemindersService } from "./timesheet-reminders.service.js";
import { NotificationsModule } from "../notifications/notifications.module.js";

@Module({
  imports: [NotificationsModule],
  controllers: [TimeController],
  providers: [TimeService, TimeCodesService, TimesheetRemindersService],
  exports: [TimeService, TimeCodesService, TimesheetRemindersService],
})
export class TimeModule {}
