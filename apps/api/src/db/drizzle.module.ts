import { Global, Module } from "@nestjs/common";
import { db } from "./index.js";

/** Injection token for the Drizzle client. Inject with `@Inject(DRIZZLE)`. */
export const DRIZZLE = Symbol("DRIZZLE");

@Global()
@Module({
  providers: [{ provide: DRIZZLE, useValue: db }],
  exports: [DRIZZLE],
})
export class DrizzleModule {}
