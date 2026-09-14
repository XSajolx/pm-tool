import { Module } from "@nestjs/common";
import { TrashController } from "./trash.controller.js";
import { TrashService } from "./trash.service.js";

@Module({
  controllers: [TrashController],
  providers: [TrashService],
})
export class TrashModule {}
