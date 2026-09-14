import { Module } from "@nestjs/common";
import { InboundEmailController } from "./inbound-email.controller.js";
import { InboundEmailService } from "./inbound-email.service.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { CommentsModule } from "../comments/comments.module.js";
import { FilesModule } from "../files/files.module.js";

/** Row 78: email-in to a project. */
@Module({
  imports: [TasksModule, CommentsModule, FilesModule],
  controllers: [InboundEmailController],
  providers: [InboundEmailService],
  exports: [InboundEmailService],
})
export class InboundModule {}
