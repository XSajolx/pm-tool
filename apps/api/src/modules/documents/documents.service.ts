import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { documents, type DocumentSettings } from "../../db/schema.js";
import type { Role } from "../auth/auth.types.js";
import { ChatEventsService } from "../chat/chat-events.service.js";

export interface DocumentWrite {
  title?: string;
  /** Plain-text rendering of `content`, sent by the editor alongside it. */
  body?: string;
  content?: Record<string, unknown> | null;
  projectId?: string | null;
  parentId?: string | null;
  icon?: string | null;
  cover?: string | null;
  settings?: DocumentSettings;
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly chatEvents: ChatEventsService,
  ) {}

  /**
   * Every live doc in the org (the client builds the page tree from `parentId`).
   * `q` matches title or body text; `projectId` narrows to one project.
   */
  async list(orgId: string, opts: { projectId?: string; q?: string } = {}) {
    const q = opts.q?.trim();
    const rows = await this.db.query.documents.findMany({
      where: and(
        eq(documents.organizationId, orgId),
        isNull(documents.archivedAt),
        ...(opts.projectId ? [eq(documents.projectId, opts.projectId)] : []),
        ...(q ? [or(ilike(documents.title, `%${q}%`), ilike(documents.body, `%${q}%`))] : []),
      ),
      with: { project: true, updatedBy: true },
      orderBy: desc(documents.updatedAt),
    });
    return rows.map((d) => ({
      id: d.id,
      title: d.title,
      icon: d.icon,
      cover: d.cover,
      parentId: d.parentId,
      excerpt: d.body.replace(/\s+/g, " ").trim().slice(0, 160),
      project: d.project ? { id: d.project.id, name: d.project.name } : null,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy ? { id: d.updatedBy.id, name: d.updatedBy.name } : null,
    }));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.documents.findFirst({
      where: and(eq(documents.id, id), eq(documents.organizationId, orgId)),
      with: {
        project: true,
        createdBy: true,
        updatedBy: true,
        parent: { columns: { id: true, title: true, icon: true } },
        children: {
          columns: { id: true, title: true, icon: true, updatedAt: true },
          where: isNull(documents.archivedAt),
          orderBy: documents.createdAt,
        },
      },
    });
    if (!row) throw new NotFoundException("Document not found");
    return {
      ...row,
      project: row.project ? { id: row.project.id, name: row.project.name } : null,
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
      updatedBy: row.updatedBy ? { id: row.updatedBy.id, name: row.updatedBy.name } : null,
    };
  }

  async create(orgId: string, userId: string, dto: DocumentWrite & { title: string }) {
    if (dto.parentId) await this.get(orgId, dto.parentId);
    const [row] = await this.db
      .insert(documents)
      .values({
        organizationId: orgId,
        title: dto.title,
        body: dto.body ?? "",
        content: dto.content ?? null,
        projectId: dto.projectId ?? null,
        parentId: dto.parentId ?? null,
        icon: dto.icon ?? null,
        cover: dto.cover ?? null,
        settings: dto.settings ?? {},
        createdById: userId,
        updatedById: userId,
      })
      .returning();
    // Row 50: a doc filed under a project is shared with its channel.
    if (row!.projectId) {
      await this.chatEvents.postProjectEvent(orgId, row!.projectId, userId, {
        type: "doc_shared",
        text: `shared the doc “${row!.title || "Untitled"}”`,
        link: `/docs/${row!.id}`,
        entityId: row!.id,
      });
    }
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: DocumentWrite) {
    const current = await this.get(orgId, id);
    if (dto.parentId) {
      if (dto.parentId === id) throw new BadRequestException("A document cannot be its own parent");
      await this.assertNotDescendant(orgId, id, dto.parentId);
    }
    const settings = dto.settings ? { ...current.settings, ...dto.settings } : undefined;
    await this.db
      .update(documents)
      .set({ ...dto, settings, updatedById: userId, updatedAt: new Date() })
      .where(eq(documents.id, id));
    return this.get(orgId, id);
  }

  /** Copy of a doc (content, settings, project, parent) titled "<title> (copy)". */
  async duplicate(orgId: string, userId: string, id: string) {
    const src = await this.get(orgId, id);
    return this.create(orgId, userId, {
      title: `${src.title} (copy)`,
      body: src.body,
      content: src.content,
      projectId: src.projectId,
      parentId: src.parentId,
      icon: src.icon,
      cover: src.cover,
      settings: src.settings,
    });
  }

  /** Creator or admin can archive. Subpages move up to the archived doc's parent. */
  async archive(orgId: string, actor: { userId: string; role: Role }, id: string) {
    const doc = await this.get(orgId, id);
    const isAdmin = actor.role === "owner" || actor.role === "admin";
    if (doc.createdBy?.id !== actor.userId && !isAdmin) {
      throw new ForbiddenException("Only the author or an admin can delete this document");
    }
    await this.db.update(documents).set({ parentId: doc.parentId }).where(eq(documents.parentId, id));
    await this.db.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, id));
    return { id, archived: true };
  }

  /** Moving `id` under `newParentId` must not create a cycle. */
  private async assertNotDescendant(orgId: string, id: string, newParentId: string) {
    let cursor: string | null = newParentId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id) throw new BadRequestException("Cannot move a document under one of its own subpages");
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const parent: { parentId: string | null } | undefined = await this.db.query.documents.findFirst({
        where: and(eq(documents.id, cursor), eq(documents.organizationId, orgId)),
        columns: { parentId: true },
      });
      if (!parent) throw new NotFoundException("Parent document not found");
      cursor = parent.parentId;
    }
  }
}
