import { Module } from "@nestjs/common";
import { LinkedFilesController } from "./linked-files.controller.js";
import { LinkedFilesService } from "./linked-files.service.js";
import { IntegrationsModule } from "../integrations/integrations.module.js";

@Module({
  imports: [IntegrationsModule],
  controllers: [LinkedFilesController],
  providers: [LinkedFilesService],
  exports: [LinkedFilesService],
})
export class LinkedFilesModule {}
