import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller.js";
import { ImportService } from "./import.service.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";

@Module({
  imports: [WorkspaceModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
