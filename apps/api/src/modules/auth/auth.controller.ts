import { Body, Controller, Get, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { AuthService } from "./auth.service.js";
import { Auth, NoOrg } from "./auth.decorators.js";
import type { AuthContext } from "./auth.types.js";

const createOrgSchema = z.object({ name: z.string().min(1).max(255) });
type CreateOrgDto = z.infer<typeof createOrgSchema>;

/**
 * Sign-up / sign-in / token refresh all happen against Supabase directly from the
 * browser — this API never sees a password. What's left for us is the part
 * Supabase can't know: which local user row and which orgs the caller maps to.
 */
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * The client's first call after a session appears. Returns the provisioned user
   * (created on the fly by AuthGuard if this is their first sign-in) plus the orgs
   * they can act in — the client picks one and sends it as x-org-id from then on.
   */
  @Get("me")
  @NoOrg()
  async me(@Auth() auth: AuthContext) {
    return {
      user: {
        id: auth.userId,
        email: auth.email,
        name: auth.name,
      },
      memberships: await this.auth.membershipsFor(auth.userId),
    };
  }

  /** Bootstrap for a fresh signup that belongs to no org yet. */
  @Post("organizations")
  @NoOrg()
  @UsePipes(new ZodValidationPipe(createOrgSchema))
  createOrganization(@Auth() auth: AuthContext, @Body() dto: CreateOrgDto) {
    return this.auth.createOrganization(auth.userId, dto.name);
  }
}
