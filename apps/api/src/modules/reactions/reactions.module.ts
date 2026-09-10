import { Global, Module } from "@nestjs/common";
import { ReactionsController } from "./reactions.controller.js";
import { ReactionsService } from "./reactions.service.js";

/** Global so chat and tasks can both fold reactions into their payloads. */
@Global()
@Module({
  controllers: [ReactionsController],
  providers: [ReactionsService],
  exports: [ReactionsService],
})
export class ReactionsModule {}
