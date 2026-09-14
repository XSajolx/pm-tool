import { Body, Controller, Delete, Get, Param, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ProjectAccessService } from "../access/project-access.service.js";
import { PortalService } from "./portal.service.js";

/** Row 120 */
const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().max(160).nullable().optional(),
  projectIds: z.array(z.string().uuid()).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  send: z.boolean().optional(),
});

/** Row 118: "Preview as client" - the team sees exactly what a guest would. */
@Controller("portal")
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get("preview/:projectId")
  async preview(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    await this.access.assertProject(auth.orgId, auth, projectId);
    return this.portal.projectView(auth.orgId, projectId);
  }

  /* ---- Row 120: guest access links (project managers) ---- */
  @Get("access")
  async listAccess(@Auth() auth: AuthContext, @Query("projectId") projectId?: string) {
    if (projectId) await this.access.assertProject(auth.orgId, auth, projectId);
    return this.portal.listAccess(auth.orgId, projectId || undefined);
  }

  @Post("access")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(inviteSchema))
  async createAccess(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof inviteSchema>) {
    for (const id of dto.projectIds) await this.access.assertProject(auth.orgId, auth, id);
    return this.portal.createAccess(auth.orgId, auth.userId, dto);
  }

  @Post("access/:id/resend")
  @Roles("owner", "admin", "member")
  resend(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.portal.sendAccess(auth.orgId, id, auth.userId);
  }

  @Delete("access/:id")
  @Roles("owner", "admin", "member")
  revoke(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.portal.revokeAccess(auth.orgId, id, auth.userId);
  }

  /* ---- Row 122: what the client did ---- */
  @Get("engagement/:projectId")
  async engagement(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    await this.access.assertProject(auth.orgId, auth, projectId);
    return this.portal.engagement(auth.orgId, projectId);
  }

  @Get("preview/:projectId/docs/:docId")
  async previewDoc(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Param("docId") docId: string) {
    await this.access.assertProject(auth.orgId, auth, projectId);
    return this.portal.doc(auth.orgId, projectId, docId);
  }
}
