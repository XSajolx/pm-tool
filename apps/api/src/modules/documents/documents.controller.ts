import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { DocumentsService, type DocLinkEntity } from "./documents.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const settingsSchema = z
  .object({
    font: z.enum(["sans", "serif", "mono"]).optional(),
    fontSize: z.enum(["sm", "md", "lg"]).optional(),
    width: z.enum(["narrow", "wide"]).optional(),
  })
  .strict();

const schema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().max(500_000).optional(),
  // TipTap document JSON. The body cap above bounds it indirectly (body mirrors content).
  content: z.record(z.unknown()).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  cover: z.string().max(64).nullable().optional(),
  settings: settingsSchema.optional(),
});

const linkEntity = z.enum(["project", "task", "company", "deal"]);
const linkSchema = z.object({ entityType: linkEntity, entityId: z.string().uuid() });
const accessSchema = z.object({
  access: z.enum(["default", "restricted"]),
  userIds: z.array(z.string().uuid()).max(100).optional(),
  roles: z.array(z.enum(["owner", "admin", "member", "guest"])).optional(),
});

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query("projectId") projectId?: string,
    @Query("q") q?: string,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
  ) {
    const type = linkEntity.safeParse(entityType);
    return this.documents.list(
      auth.orgId,
      {
        projectId: projectId || undefined,
        q: q || undefined,
        entityType: type.success ? type.data : undefined,
        entityId: type.success && entityId ? entityId : undefined,
      },
      { userId: auth.userId, role: auth.role },
    );
  }

  /** Row 62: who can open this doc. */
  @Patch(":id/access")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(accessSchema))
  setAccess(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof accessSchema>) {
    return this.documents.setAccess(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto);
  }

  /** Row 61: attach this doc to a project, task, client or deal. */
  @Post(":id/links")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(linkSchema))
  addLink(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof linkSchema>) {
    return this.documents.addLink(auth.orgId, auth.userId, id, dto.entityType as DocLinkEntity, dto.entityId);
  }

  @Delete(":id/links/:linkId")
  @Roles("owner", "admin", "member")
  removeLink(@Auth() auth: AuthContext, @Param("id") id: string, @Param("linkId") linkId: string) {
    return this.documents.removeLink(auth.orgId, id, linkId);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.documents.get(auth.orgId, id, { userId: auth.userId, role: auth.role });
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    return this.documents.create(auth.orgId, auth.userId, dto);
  }

  @Post(":id/duplicate")
  @Roles("owner", "admin", "member")
  duplicate(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.documents.duplicate(auth.orgId, auth.userId, id);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof schema>>) {
    return this.documents.update(auth.orgId, auth.userId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin", "member")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.documents.archive(auth.orgId, { userId: auth.userId, role: auth.role }, id);
  }
}
