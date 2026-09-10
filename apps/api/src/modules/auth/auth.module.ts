import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { TokenService } from "./token.service.js";
import { AuthGuard } from "./auth.guard.js";
import { OrgGuard } from "./org.guard.js";
import { RolesGuard } from "./roles.guard.js";

/**
 * Guards are registered as APP_GUARD so they apply to every route in the app,
 * in this order: authenticate → resolve org membership → check role.
 * Opt out per-route with @Public() / @NoOrg().
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OrgGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
