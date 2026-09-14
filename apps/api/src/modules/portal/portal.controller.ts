import { Controller, Get, Param } from "@nestjs/common";
import { Auth } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ProjectAccessService } from "../access/project-access.service.js";
import { PortalService } from "./portal.service.js";

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

  @Get("preview/:projectId/docs/:docId")
  async previewDoc(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Param("docId") docId: string) {
    await this.access.assertProject(auth.orgId, auth, projectId);
    return this.portal.doc(auth.orgId, projectId, docId);
  }
}
