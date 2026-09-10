import { Module } from "@nestjs/common";
import { IntakeController } from "./intake.controller.js";
import { IntakeService } from "./intake.service.js";

@Module({
  controllers: [IntakeController],
  providers: [IntakeService],
})
export class IntakeModule {}
