import { Module } from "@nestjs/common";
import { ResourcingController } from "./resourcing.controller.js";
import { ResourcingService } from "./resourcing.service.js";
import { TimeModule } from "../time/time.module.js";

@Module({
  imports: [TimeModule],
  controllers: [ResourcingController],
  providers: [ResourcingService],
})
export class ResourcingModule {}
