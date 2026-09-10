import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AuthService } from "./auth.service.js";
import { IS_PUBLIC, SKIP_ORG } from "./auth.decorators.js";

/**
 * Second half of the identity story: the caller says which org they're acting in
 * via `x-org-id`, and we verify a membership actually exists before any handler
 * sees that id. This is what stops a valid token for org A from reading org B —
 * previously `x-org-id` was simply believed.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== "http") return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ORG, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip || isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.auth) throw new ForbiddenException("Not authenticated");

    const orgId = req.headers["x-org-id"];
    if (typeof orgId !== "string" || !orgId) {
      throw new BadRequestException("Missing x-org-id header");
    }

    const membership = await this.auth.membershipIn(req.auth.userId, orgId);
    if (!membership) {
      // Same response whether the org doesn't exist or they're just not in it —
      // don't leak which org ids are real.
      throw new ForbiddenException("Not a member of this organization");
    }

    req.auth.orgId = membership.organizationId;
    req.auth.role = membership.role;
    return true;
  }
}
