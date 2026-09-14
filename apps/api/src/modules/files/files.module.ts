import { Module } from "@nestjs/common";
import { FilesController } from "./files.controller.js";
import { FilesService } from "./files.service.js";
import { StorageService } from "./storage.service.js";

/** File uploads + storage backend (row 43). Chat imports it to attach files to messages. */
@Module({
  controllers: [FilesController],
  providers: [StorageService, FilesService],
  exports: [StorageService, FilesService],
})
export class FilesModule {}
