import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ROLES } from "./auth.decorators.js";
import type { Role } from "./auth.types.js";

/**
 * Enforces @Roles(...) against the membership role resolved by OrgGuard.
 * Routes without the decorator are open to any member of the org.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== "http") return true;
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.auth || !required.includes(req.auth.role)) {
      throw new ForbiddenException(
        `Requires role: ${required.join(" or ")}`,
      );
    }
    return true;
  }
}
