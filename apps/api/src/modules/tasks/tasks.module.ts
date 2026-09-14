import { Module } from "@nestjs/common";
import { TasksController } from "./tasks.controller.js";
import { TasksService } from "./tasks.service.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { CommentsModule } from "../comments/comments.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { ChatModule } from "../chat/chat.module.js";

@Module({
  imports: [NotificationsModule, CommentsModule, ProjectsModule, ChatModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
