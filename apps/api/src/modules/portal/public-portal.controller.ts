import { Body, Controller, Get, Param, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Public } from "../auth/auth.decorators.js";
import { PortalService } from "./portal.service.js";

const decisionSchema = z.object({
  kind: z.enum(["milestone", "document"]),
  id: z.string().uuid(),
  decision: z.enum(["approved", "changes_requested"]),
  note: z.string().max(2000).optional(),
});

/** Rows 120-122: the guest side. The token in the link is the credential; every open is logged. */
@Controller("public/portal")
export class PublicPortalController {
  constructor(private readonly portal: PortalService) {}

  @Public()
  @Get(":token")
  home(@Param("token") token: string) {
    return this.portal.guestHome(token);
  }

  @Public()
  @Get(":token/projects/:projectId")
  project(@Param("token") token: string, @Param("projectId") projectId: string) {
    return this.portal.guestProject(token, projectId);
  }

  @Public()
  @Get(":token/projects/:projectId/docs/:docId")
  doc(@Param("token") token: string, @Param("projectId") projectId: string, @Param("docId") docId: string) {
    return this.portal.guestDoc(token, projectId, docId);
  }

  /** Row 121 */
  @Public()
  @Post(":token/projects/:projectId/decisions")
  @UsePipes(new ZodValidationPipe(decisionSchema))
  decide(@Param("token") token: string, @Param("projectId") projectId: string, @Body() dto: z.infer<typeof decisionSchema>) {
    return this.portal.guestDecide(token, projectId, dto);
  }
}
