import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { StagesController } from "./stages.controller.js";
import { StagesService } from "./stages.service.js";

@Module({
  controllers: [ProjectsController, StagesController],
  providers: [ProjectsService, StagesService],
  exports: [ProjectsService, StagesService],
})
export class ProjectsModule {}
