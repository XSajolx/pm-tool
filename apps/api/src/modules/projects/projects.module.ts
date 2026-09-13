import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { StagesController } from "./stages.controller.js";
import { StagesService } from "./stages.service.js";
import { MilestonesController } from "./milestones.controller.js";
import { MilestonesService } from "./milestones.service.js";

@Module({
  controllers: [ProjectsController, StagesController, MilestonesController],
  providers: [ProjectsService, StagesService, MilestonesService],
  exports: [ProjectsService, StagesService, MilestonesService],
})
export class ProjectsModule {}
