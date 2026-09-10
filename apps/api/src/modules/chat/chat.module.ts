import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";
import { ChatGateway } from "./chat.gateway.js";

@Module({
  controllers: [ChatController],
  providers: [ChatService, ChatGateway],
  // Exported so NotificationsService can push into a user's personal room.
  exports: [ChatGateway, ChatService],
})
export class ChatModule {}
