import { Module } from "@nestjs/common";
import { TasksController } from "./tasks.controller.js";
import { TasksService } from "./tasks.service.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { CommentsModule } from "../comments/comments.module.js";

@Module({
  imports: [NotificationsModule, CommentsModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
