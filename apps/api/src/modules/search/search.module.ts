import { Module } from "@nestjs/common";
import { SearchController } from "./search.controller.js";
import { SearchService } from "./search.service.js";
import { DocumentsModule } from "../documents/documents.module.js";

@Module({
  imports: [DocumentsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
