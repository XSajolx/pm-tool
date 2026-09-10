import { Global, Module } from "@nestjs/common";
import { ActivityService } from "./activity.service.js";

/** Global: almost every feature module records activity. */
@Global()
@Module({
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
