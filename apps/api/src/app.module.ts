import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DrizzleModule } from "./db/drizzle.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { AccessModule } from "./modules/access/access.module.js";
import { ActivityModule } from "./modules/activity/activity.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { HealthController } from "./health.controller.js";
import { TasksModule } from "./modules/tasks/tasks.module.js";
import { WorkspaceModule } from "./modules/workspace/workspace.module.js";
import { ChatModule } from "./modules/chat/chat.module.js";
import { ReactionsModule } from "./modules/reactions/reactions.module.js";
import { CyclesModule } from "./modules/cycles/cycles.module.js";
import { ViewsModule } from "./modules/views/views.module.js";
import { IntakeModule } from "./modules/intake/intake.module.js";
import { CommentsModule } from "./modules/comments/comments.module.js";
import { ProjectsModule } from "./modules/projects/projects.module.js";
import { TimeModule } from "./modules/time/time.module.js";
import { ResourcingModule } from "./modules/resourcing/resourcing.module.js";
import { CrmModule } from "./modules/crm/crm.module.js";
import { DocumentsModule } from "./modules/documents/documents.module.js";
import { FilesModule } from "./modules/files/files.module.js";
import { InboundModule } from "./modules/inbound/inbound.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DrizzleModule,
    AuthModule,
    AccessModule,
    ActivityModule,
    NotificationsModule,
    TasksModule,
    WorkspaceModule,
    ChatModule,
    FilesModule,
    ReactionsModule,
    CyclesModule,
    ViewsModule,
    IntakeModule,
    CommentsModule,
    ProjectsModule,
    TimeModule,
    ResourcingModule,
    CrmModule,
    DocumentsModule,
    InboundModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
