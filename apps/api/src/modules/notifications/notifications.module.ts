import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { RemindersService } from "./reminders.service.js";
import { MailerService } from "./mailer.service.js";
import { ChatModule } from "../chat/chat.module.js";

/** Imports ChatModule for its gateway - notifications ride the same socket. */
@Module({
  imports: [ChatModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, RemindersService, MailerService],
  exports: [NotificationsService, RemindersService, MailerService],
})
export class NotificationsModule {}
