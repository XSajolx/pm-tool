import { Body, Controller, Get, Param, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { DocVersionsService } from "./doc-versions.service.js";
import { DocumentsService } from "./documents.service.js";

const saveSchema = z.object({ label: z.string().max(120).nullable().optional() });

/** Row 21: version history. */
@Controller("documents/:id/versions")
export class DocVersionsController {
  constructor(
    private readonly versions: DocVersionsService,
    private readonly documents: DocumentsService,
  ) {}

  @Get()
  async list(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.documents.get(auth.orgId, id, { userId: auth.userId, role: auth.role });
    return this.versions.list(auth.orgId, id);
  }

  @Get(":versionId")
  async get(@Auth() auth: AuthContext, @Param("id") id: string, @Param("versionId") versionId: string) {
    await this.documents.get(auth.orgId, id, { userId: auth.userId, role: auth.role });
    return this.versions.get(auth.orgId, id, versionId);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(saveSchema))
  async save(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof saveSchema>) {
    await this.documents.get(auth.orgId, id, { userId: auth.userId, role: auth.role });
    return this.versions.save(auth.orgId, id, auth.userId, dto.label);
  }

  @Post(":versionId/restore")
  @Roles("owner", "admin", "member")
  async restore(@Auth() auth: AuthContext, @Param("id") id: string, @Param("versionId") versionId: string) {
    await this.documents.get(auth.orgId, id, { userId: auth.userId, role: auth.role });
    return this.versions.restore(auth.orgId, id, auth.userId, versionId);
  }
}
