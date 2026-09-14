import { Module } from "@nestjs/common";
import { CustomFieldsController } from "./custom-fields.controller.js";
import { CustomFieldsService } from "./custom-fields.service.js";

@Module({
  controllers: [CustomFieldsController],
  providers: [CustomFieldsService],
  exports: [CustomFieldsService],
})
export class CustomFieldsModule {}
