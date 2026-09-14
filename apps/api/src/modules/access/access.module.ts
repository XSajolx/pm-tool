import { Global, Module } from "@nestjs/common";
import { ProjectAccessService } from "./project-access.service.js";

/** Row 84: who may see which project. Global so every module can gate reads without import cycles. */
@Global()
@Module({
  providers: [ProjectAccessService],
  exports: [ProjectAccessService],
})
export class AccessModule {}
