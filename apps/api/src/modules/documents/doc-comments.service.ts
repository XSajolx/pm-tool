import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { docComments, documents, users } from "../../db/schema.js";
import { DocumentsService, type Viewer } from "./documents.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { ActivityService } from "../activity/activity.service.js";

/** Row 16: threaded comments on a doc, anchored to highlighted text. */
@Injectable()
export class DocCommentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly documents: DocumentsService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  private shape(c: typeof docComments.$inferSelect & { author?: { id: string; name: string; avatarUrl: string | null } | null; resolvedBy?: { id: string; name: string } | null }) {
    return {
      id: c.id,
      documentId: c.documentId,
      parentId: c.parentId,
      quote: c.quote,
      body: c.body,
      author: c.author ?? null,
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      resolvedBy: c.resolvedBy ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  async list(orgId: string, viewer: Viewer, docId: string) {
    await this.documents.get(orgId, docId, viewer);
    const rows = await this.db.query.docComments.findMany({
      where: and(eq(docComments.organizationId, orgId), eq(docComments.documentId, docId)),
      with: { author: { columns: { id: true, name: true, avatarUrl: true } }, resolvedBy: { columns: { id: true, name: true } } },
      orderBy: [asc(docComments.createdAt)],
    });
    const all = rows.map((c) => this.shape(c));
    const roots = all.filter((c) => !c.parentId);
    return roots.map((root) => ({ ...root, replies: all.filter((c) => c.parentId === root.id) }));
  }

  async create(orgId: string, viewer: Viewer, docId: string, dto: { body: string; quote?: string | null; parentId?: string | null }) {
    const doc = await this.documents.get(orgId, docId, viewer);
    const body = dto.body.trim();
    if (!body) throw new BadRequestException("Write something first");
    let parent: typeof docComments.$inferSelect | undefined;
    if (dto.parentId) {
      parent = await this.db.query.docComments.findFirst({ where: and(eq(docComments.id, dto.parentId), eq(docComments.documentId, docId)) });
      if (!parent) throw new NotFoundException("Thread not found");
      if (parent.parentId) throw new BadRequestException("Reply to the thread, not to a reply");
    }
    const [row] = await this.db
      .insert(docComments)
      .values({ organizationId: orgId, documentId: docId, authorId: viewer.userId, parentId: parent?.id ?? null, quote: parent ? null : dto.quote?.trim().slice(0, 500) || null, body })
      .returning();
    const [actor] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId));
    const title = `${actor?.name ?? "Someone"} commented on “${doc.title || "Untitled"}”`;
    const preview = `${row!.quote ? `“${row!.quote.slice(0, 80)}” — ` : ""}${body.slice(0, 140)}`;
    // Followers hear about it; the thread starter always does on a reply.
    const exclude = [viewer.userId];
    await this.notifications.notifyFollowers({ orgId, entityType: "document", entityId: docId, actorId: viewer.userId, verb: "doc_commented", title, body: preview, data: { documentId: docId, commentId: row!.id }, exclude });
    if (parent?.authorId && parent.authorId !== viewer.userId) {
      await this.notifications.notifyDirect({ orgId, receiverId: parent.authorId, actorId: viewer.userId, entityType: "document", entityId: docId, verb: "doc_comment_replied", title: `${actor?.name ?? "Someone"} replied to your comment on “${doc.title || "Untitled"}”`, body: body.slice(0, 140), data: { documentId: docId, commentId: parent.id }, category: "primary" });
    }
    // Row 77: commenting follows the doc; row 102: the project feed shows it.
    await this.notifications.follow(orgId, viewer.userId, "document", docId, "manual");
    await this.activity.record({ orgId, actorId: viewer.userId, entityType: "document", entityId: docId, action: "commented" });
    return this.one(row!.id);
  }

  async resolve(orgId: string, viewer: Viewer, docId: string, id: string, resolved: boolean) {
    await this.documents.get(orgId, docId, viewer);
    const rows = await this.db
      .update(docComments)
      .set({ resolvedAt: resolved ? new Date() : null, resolvedById: resolved ? viewer.userId : null, updatedAt: new Date() })
      .where(and(eq(docComments.id, id), eq(docComments.documentId, docId), eq(docComments.organizationId, orgId)))
      .returning({ id: docComments.id });
    if (!rows.length) throw new NotFoundException("Comment not found");
    return this.one(id);
  }

  async remove(orgId: string, viewer: Viewer, docId: string, id: string) {
    await this.documents.get(orgId, docId, viewer);
    const c = await this.db.query.docComments.findFirst({ where: and(eq(docComments.id, id), eq(docComments.documentId, docId), eq(docComments.organizationId, orgId)) });
    if (!c) throw new NotFoundException("Comment not found");
    const admin = viewer.role === "owner" || viewer.role === "admin";
    if (c.authorId !== viewer.userId && !admin) throw new ForbiddenException("Only the author or an admin can delete this comment");
    await this.db.delete(docComments).where(eq(docComments.id, id));
    return { id, deleted: true };
  }

  private async one(id: string) {
    const c = await this.db.query.docComments.findFirst({ where: eq(docComments.id, id), with: { author: { columns: { id: true, name: true, avatarUrl: true } }, resolvedBy: { columns: { id: true, name: true } } } });
    return this.shape(c!);
  }
}
