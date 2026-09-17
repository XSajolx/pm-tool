import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { AutomationsController } from "./automations.controller.js";
import { AutomationsService } from "./automations.service.js";

/** Rows 153-155: when X then Y, driven off the activity log. */
@Module({
  imports: [NotificationsModule, TasksModule],
  controllers: [AutomationsController],
  providers: [AutomationsService],
  exports: [AutomationsService],
})
export class AutomationsModule {}
