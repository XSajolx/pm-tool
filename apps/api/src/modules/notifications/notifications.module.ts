import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { ChatModule } from "../chat/chat.module.js";

/** Imports ChatModule for its gateway - notifications ride the same socket. */
@Module({
  imports: [ChatModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
