import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { StagesController } from "./stages.controller.js";
import { StagesService } from "./stages.service.js";
import { MilestonesController } from "./milestones.controller.js";
import { MilestonesService } from "./milestones.service.js";
import { TemplatesController } from "./templates.controller.js";
import { TemplatesService } from "./templates.service.js";

@Module({
  controllers: [ProjectsController, StagesController, MilestonesController, TemplatesController],
  providers: [ProjectsService, StagesService, MilestonesService, TemplatesService],
  exports: [ProjectsService, StagesService, MilestonesService, TemplatesService],
})
export class ProjectsModule {}
