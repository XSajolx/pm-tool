import { Module } from "@nestjs/common";
import { TimeController } from "./time.controller.js";
import { TimeService } from "./time.service.js";

@Module({
  controllers: [TimeController],
  providers: [TimeService],
  exports: [TimeService],
})
export class TimeModule {}
