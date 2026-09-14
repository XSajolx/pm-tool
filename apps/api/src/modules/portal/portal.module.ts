import { Module } from "@nestjs/common";
import { PortalController } from "./portal.controller.js";
import { PortalService } from "./portal.service.js";
import { DocumentsModule } from "../documents/documents.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PublicPortalController } from "./public-portal.controller.js";

@Module({
  imports: [DocumentsModule, NotificationsModule],
  controllers: [PortalController, PublicPortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
