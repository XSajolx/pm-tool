import { Body, Controller, Get, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { AuthService } from "./auth.service.js";
import { SignInService } from "./sign-in.service.js";
import { Auth, NoOrg, Public, Roles } from "./auth.decorators.js";
import type { AuthContext } from "./auth.types.js";

const createOrgSchema = z.object({ name: z.string().min(1).max(255) });
/** Row 79 */
const signInSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(200) });
/** Row 80 */
const ssoSchema = z.object({ ssoDomain: z.string().max(255).regex(/^@?[a-z0-9.-]+\.[a-z]{2,}$/i, "Enter a domain like 4s.digital").nullable() });
type CreateOrgDto = z.infer<typeof createOrgSchema>;

/**
 * Sign-up / sign-in / token refresh all happen against Supabase directly from the
 * browser — this API never sees a password. What's left for us is the part
 * Supabase can't know: which local user row and which orgs the caller maps to.
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly signInService: SignInService,
  ) {}

  /**
   * Row 79: password sign-in with lockout. Proxies to Supabase so the lock
   * counter lives server-side; returns the session for the browser to adopt.
   */
  @Public()
  @NoOrg()
  @Post("sign-in")
  @UsePipes(new ZodValidationPipe(signInSchema))
  signIn(@Body() dto: z.infer<typeof signInSchema>) {
    return this.signInService.signIn(dto.email, dto.password);
  }

  /** Row 79: lets the form say "locked until…" before the user types a password. */
  @Public()
  @NoOrg()
  @Get("sign-in/status")
  signInStatus(@Query("email") email?: string) {
    return email ? this.signInService.status(email) : { locked: false, lockedUntil: null };
  }

  /**
   * The client's first call after a session appears. Returns the provisioned user
   * (created on the fly by AuthGuard if this is their first sign-in) plus the orgs
   * they can act in — the client picks one and sends it as x-org-id from then on.
   */
  @Get("me")
  @NoOrg()
  async me(@Auth() auth: AuthContext) {
    // Row 80: a Google-verified address on a workspace's domain joins it automatically.
    await this.auth.autoJoinBySsoDomain(auth.userId, auth.email, auth.provider);
    return {
      user: {
        id: auth.userId,
        email: auth.email,
        name: auth.name,
      },
      memberships: await this.auth.membershipsFor(auth.userId),
    };
  }

  /* ---- Row 80: Google Workspace SSO settings (org-scoped) ---- */

  @Get("sso")
  sso(@Auth() auth: AuthContext) {
    return this.auth.getSso(auth.orgId);
  }

  @Patch("sso")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(ssoSchema))
  updateSso(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof ssoSchema>) {
    return this.auth.updateSso(auth.orgId, dto.ssoDomain);
  }

  /** Bootstrap for a fresh signup that belongs to no org yet. */
  @Post("organizations")
  @NoOrg()
  @UsePipes(new ZodValidationPipe(createOrgSchema))
  createOrganization(@Auth() auth: AuthContext, @Body() dto: CreateOrgDto) {
    return this.auth.createOrganization(auth.userId, dto.name);
  }
}
