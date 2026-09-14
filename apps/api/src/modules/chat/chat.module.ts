import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";
import { ChatGateway } from "./chat.gateway.js";
import { FilesModule } from "../files/files.module.js";
import { ChatEventsService } from "./chat-events.service.js";

@Module({
  imports: [FilesModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, ChatEventsService],
  // Exported so NotificationsService can push into a user's personal room.
  exports: [ChatGateway, ChatService, ChatEventsService],
})
export class ChatModule {}
