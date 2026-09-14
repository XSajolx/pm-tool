import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AuthService } from "./auth.service.js";
import { TokenService } from "./token.service.js";
import { IS_PUBLIC } from "./auth.decorators.js";
import { MfaService } from "./mfa.service.js";

/**
 * Registered globally (see auth.module), so every route is authenticated unless
 * it opts out with @Public(). Default-deny is the point: a new controller added
 * later is protected without anyone remembering to protect it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly mfa: MfaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== "http") return true; // WS is guarded in ChatGateway
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const claims = await this.tokens.verify(header.slice("Bearer ".length).trim());
    const user = await this.auth.resolveUser(claims);
    const provider = (claims as { app_metadata?: { provider?: string } }).app_metadata?.provider;
    // Row 81: is this session second-factor verified (aal2 or a backup code)?
    const mfa = await this.mfa.sessionState(user, claims as { aal?: string; session_id?: string });
    req.auth = { ...this.auth.toContext(user), provider, mfa };
    return true;
  }
}
