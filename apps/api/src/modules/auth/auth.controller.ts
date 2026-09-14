import { Body, Controller, Delete, ForbiddenException, Get, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { AuthService } from "./auth.service.js";
import { SignInService } from "./sign-in.service.js";
import { MfaService } from "./mfa.service.js";
import { AllowUnverifiedMfa, Auth, NoOrg, Public, Roles } from "./auth.decorators.js";
import type { AuthContext } from "./auth.types.js";

const createOrgSchema = z.object({ name: z.string().min(1).max(255) });
/** Row 79 */
const signInSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(200) });
/** Row 80 */
const ssoSchema = z.object({ ssoDomain: z.string().max(255).regex(/^@?[a-z0-9.-]+\.[a-z]{2,}$/i, "Enter a domain like 4s.digital").nullable() });
type CreateOrgDto = z.infer<typeof createOrgSchema>;
/** Row 81 */
const backupUseSchema = z.object({ code: z.string().min(6).max(20) });
const mfaPolicySchema = z.object({ roles: z.array(z.enum(["owner", "admin", "member", "guest"])).max(4) });

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
    private readonly mfa: MfaService,
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
    const memberships = await this.auth.membershipsFor(auth.userId);
    return {
      user: {
        id: auth.userId,
        email: auth.email,
        name: auth.name,
      },
      memberships,
      // Row 81: what the shell needs to decide between "verify", "enrol" and "carry on".
      mfa: { enrolled: auth.mfa?.enrolled ?? false, verified: auth.mfa?.verified ?? true },
    };
  }

  /* ---- Row 81: two-factor authentication ---- */

  @Get("mfa")
  @NoOrg()
  async mfaStatus(@Auth() auth: AuthContext) {
    return { enrolled: auth.mfa?.enrolled ?? false, verified: auth.mfa?.verified ?? true, backupCodesLeft: await this.mfa.backupCodesLeft(auth.userId) };
  }

  /** The browser verified its new TOTP factor with Supabase; record it and hand back backup codes. */
  @Post("mfa/enrolled")
  @NoOrg()
  @AllowUnverifiedMfa()
  mfaEnrolled(@Auth() auth: AuthContext) {
    return this.mfa.markEnrolled(auth.userId);
  }

  /** Turning 2FA off needs a verified session - a stolen aal1 token can't strip it. */
  @Delete("mfa")
  @NoOrg()
  mfaDisable(@Auth() auth: AuthContext) {
    if (auth.mfa?.enrolled && !auth.mfa.verified) throw new ForbiddenException("Verify your second factor first");
    return this.mfa.markUnenrolled(auth.userId);
  }

  @Post("mfa/backup-codes")
  @NoOrg()
  mfaBackupCodes(@Auth() auth: AuthContext) {
    if (!auth.mfa?.enrolled) throw new ForbiddenException("Enable two-factor authentication first");
    if (!auth.mfa.verified) throw new ForbiddenException("Verify your second factor first");
    return this.mfa.regenerateBackupCodes(auth.userId);
  }

  /** Lost the phone? A backup code verifies this session for twelve hours. */
  @Post("mfa/backup/use")
  @NoOrg()
  @AllowUnverifiedMfa()
  @UsePipes(new ZodValidationPipe(backupUseSchema))
  mfaUseBackup(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof backupUseSchema>) {
    return this.mfa.useBackupCode(auth.userId, auth.mfa?.sessionId ?? null, dto.code);
  }

  /** Workspace policy: which roles must have 2FA. Org-scoped, admins only. */
  @Get("mfa/policy")
  async mfaPolicy(@Auth() auth: AuthContext) {
    return { mfaRequiredRoles: await this.mfa.requiredRoles(auth.orgId) };
  }

  @Patch("mfa/policy")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(mfaPolicySchema))
  updateMfaPolicy(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof mfaPolicySchema>) {
    return this.mfa.setRequiredRoles(auth.orgId, dto.roles);
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
