import { Module } from "@nestjs/common";
import { PortalController } from "./portal.controller.js";
import { PortalService } from "./portal.service.js";
import { DocumentsModule } from "../documents/documents.module.js";

@Module({
  imports: [DocumentsModule],
  controllers: [PortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
