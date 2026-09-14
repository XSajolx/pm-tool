import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { IS_PUBLIC, SKIP_MFA, SKIP_ORG } from "./auth.decorators.js";
import { MfaService } from "./mfa.service.js";

/**
 * Row 81: runs after OrgGuard (so the role is known). Two rules:
 *   - enrolled but this session isn't second-factor verified -> 401 mfa_required
 *   - not enrolled but the workspace requires 2FA for this role -> 403 mfa_enrollment_required
 * /auth/me and the /auth/mfa/* routes are exempt so the client can find out
 * what to do and do it.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mfa: MfaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== "http") return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_MFA, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_ORG, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const auth = req.auth;
    if (!auth?.mfa) return true;
    if (auth.mfa.enrolled && !auth.mfa.verified) {
      throw new UnauthorizedException({ code: "mfa_required", message: "Enter your two-factor code to continue" });
    }
    if (!auth.mfa.enrolled && auth.orgId) {
      const required = await this.mfa.requiredRoles(auth.orgId);
      if (required.includes(auth.role)) {
        throw new ForbiddenException({ code: "mfa_enrollment_required", message: "This workspace requires two-factor authentication for your role" });
      }
    }
    return true;
  }
}
