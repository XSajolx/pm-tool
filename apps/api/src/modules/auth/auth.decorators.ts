import {
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthContext, Role } from "./auth.types.js";

/** Skip authentication entirely (health check, and nothing else by default). */
export const IS_PUBLIC = "auth:public";
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Route needs a verified user but no org context — used by /auth/me, which is
 * what the client calls *before* it knows which orgs the user belongs to.
 */
export const SKIP_ORG = "auth:skip-org";
export const NoOrg = () => SetMetadata(SKIP_ORG, true);

/** Row 81: route works even when the session hasn't passed 2FA yet (the 2FA routes themselves). */
export const SKIP_MFA = "auth:skip-mfa";
export const AllowUnverifiedMfa = () => SetMetadata(SKIP_MFA, true);

/** Restrict a route to the given membership roles. Requires org context. */
export const ROLES = "auth:roles";
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

/** Injects the verified AuthContext. Replaces the old x-org-id/x-user-id headers. */
export const Auth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    // Non-null: the global guards reject the request before a handler runs.
    return req.auth!;
  },
);
