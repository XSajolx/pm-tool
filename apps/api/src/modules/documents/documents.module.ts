import { Module } from "@nestjs/common";
import { DocCommentsController } from "./doc-comments.controller.js";
import { DocCommentsService } from "./doc-comments.service.js";
import { DocVersionsController } from "./doc-versions.controller.js";
import { DocVersionsService } from "./doc-versions.service.js";
import { DocumentsController } from "./documents.controller.js";
import { PublicDocumentsController } from "./public-documents.controller.js";
import { SnippetsController } from "./snippets.controller.js";
import { BrandingController } from "./branding.controller.js";
import { DocTemplatesController } from "./doc-templates.controller.js";
import { DocTemplatesService } from "./doc-templates.service.js";
import { SnippetsService } from "./snippets.service.js";
import { DocumentsService } from "./documents.service.js";
import { ChatModule } from "../chat/chat.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";

@Module({
  imports: [ChatModule, NotificationsModule],
  controllers: [DocumentsController, PublicDocumentsController, SnippetsController, BrandingController, DocTemplatesController, DocCommentsController, DocVersionsController],
  providers: [DocumentsService, SnippetsService, DocTemplatesService, DocCommentsService, DocVersionsService],
  exports: [DocumentsService, DocTemplatesService],
})
export class DocumentsModule {}
