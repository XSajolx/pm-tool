import { Global, Module } from "@nestjs/common";
import { ActivityService } from "./activity.service.js";
import { ActivityController } from "./activity.controller.js";

/** Global: almost every feature module records activity. */
@Global()
@Module({
  controllers: [ActivityController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
