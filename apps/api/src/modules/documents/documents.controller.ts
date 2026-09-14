import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UsePipes } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { DocumentsService, type DocLinkEntity } from "./documents.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import { ActivityService } from "../activity/activity.service.js";
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
const reviewRequestSchema = z.object({ approverId: z.string().uuid(), note: z.string().max(2000).optional() });
const reviewDecisionSchema = z.object({ approve: z.boolean(), note: z.string().max(2000).optional() });
const supersedeSchema = z.object({ byDocumentId: z.string().uuid(), effectiveFrom: z.string().datetime().nullable().optional() });
const accessSchema = z.object({
  access: z.enum(["default", "restricted"]),
  userIds: z.array(z.string().uuid()).max(100).optional(),
  roles: z.array(z.enum(["owner", "admin", "member", "guest"])).optional(),
});

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService, private readonly activity: ActivityService) {}

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

  /* Row 69: recent & starred (declared before ":id"). */
  @Get("recent")
  recent(@Auth() auth: AuthContext) {
    return this.documents.recent(auth.orgId, { userId: auth.userId, role: auth.role });
  }

  @Get("starred")
  starred(@Auth() auth: AuthContext) {
    return this.documents.starred(auth.orgId, { userId: auth.userId, role: auth.role });
  }

  @Post(":id/star")
  toggleStar(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.documents.toggleStar(auth.orgId, auth.userId, id);
  }

  /** Row 70: this doc is replaced by a newer one from a date; the old one stays readable. */
  @Post(":id/supersede")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(supersedeSchema))
  supersede(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof supersedeSchema>) {
    return this.documents.supersede(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto.byDocumentId, dto.effectiveFrom);
  }

  @Delete(":id/supersede")
  @Roles("owner", "admin", "member")
  unsupersede(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.documents.unsupersede(auth.orgId, { userId: auth.userId, role: auth.role }, id);
  }

  /** Row 67: branded PDF export (internal blocks stripped, snippets expanded). */
  @Get(":id/pdf")
  async pdf(@Auth() auth: AuthContext, @Param("id") id: string, @Res() res: Response) {
    const { bytes, filename } = await this.documents.pdf(auth.orgId, id, { userId: auth.userId, role: auth.role });
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }

  /** Row 65: public read-only link. Internal-only blocks never leave the team. */
  @Post(":id/share")
  @Roles("owner", "admin", "member")
  async enableShare(@Auth() auth: AuthContext, @Param("id") id: string) {
    const result = await this.documents.enableShare(auth.orgId, { userId: auth.userId, role: auth.role }, id);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "document", entityId: id, action: "share_enabled" });
    return result;
  }

  @Delete(":id/share")
  @Roles("owner", "admin", "member")
  async disableShare(@Auth() auth: AuthContext, @Param("id") id: string) {
    const result = await this.documents.disableShare(auth.orgId, { userId: auth.userId, role: auth.role }, id);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "document", entityId: id, action: "share_disabled" });
    return result;
  }

  /** Row 63: ask someone to sign the doc off. */
  @Post(":id/review")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(reviewRequestSchema))
  requestReview(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof reviewRequestSchema>) {
    return this.documents.requestReview(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto.approverId, dto.note);
  }

  @Post(":id/review/decision")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(reviewDecisionSchema))
  decideReview(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof reviewDecisionSchema>) {
    return this.documents.decideReview(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto.approve, dto.note);
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
  async get(@Auth() auth: AuthContext, @Param("id") id: string) {
    const doc = await this.documents.get(auth.orgId, id, { userId: auth.userId, role: auth.role });
    // Row 69: opening a doc puts it in "Recent" — best effort, never blocks the read.
    void this.documents.recordVisit(auth.orgId, auth.userId, id).catch(() => undefined);
    return doc;
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
  async archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    const result = await this.documents.archive(auth.orgId, { userId: auth.userId, role: auth.role }, id);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "document", entityId: id, action: "deleted" });
    return result;
  }
}
