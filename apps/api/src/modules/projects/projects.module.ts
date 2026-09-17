import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { StagesController } from "./stages.controller.js";
import { StagesService } from "./stages.service.js";
import { MilestonesController } from "./milestones.controller.js";
import { MilestonesService } from "./milestones.service.js";
import { TemplatesController } from "./templates.controller.js";
import { TemplatesService } from "./templates.service.js";
import { ChatModule } from "../chat/chat.module.js";
import { DocumentsModule } from "../documents/documents.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { FinanceModule } from "../finance/finance.module.js";
import { StageBudgetsService } from "./stage-budgets.service.js";

@Module({
  // ChatModule: every project owns a chat channel whose members follow the project team (row 39).
  imports: [ChatModule, DocumentsModule, NotificationsModule, FinanceModule],
  controllers: [ProjectsController, StagesController, MilestonesController, TemplatesController],
  providers: [ProjectsService, StagesService, MilestonesService, TemplatesService, StageBudgetsService],
  exports: [ProjectsService, StagesService, MilestonesService, TemplatesService, StageBudgetsService],
})
export class ProjectsModule {}
