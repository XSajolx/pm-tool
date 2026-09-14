import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, deals, documentAccess, documentLinks, documents, projectMembers, projects, tasks, type DocumentSettings } from "../../db/schema.js";
import type { Role } from "../auth/auth.types.js";
import { ChatEventsService } from "../chat/chat-events.service.js";

export type DocLinkEntity = "project" | "task" | "company" | "deal";

/** Who is asking — needed to decide which docs they may open (row 62). */
export interface Viewer {
  userId: string;
  role: Role;
}

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
  async list(orgId: string, opts: { projectId?: string; q?: string; entityType?: DocLinkEntity; entityId?: string } = {}, viewer?: Viewer) {
    const q = opts.q?.trim();
    // Row 61: docs attached to one record — explicit links, plus (for projects) docs filed under it.
    let scope: ReturnType<typeof or> | undefined;
    if (opts.entityType && opts.entityId) {
      const links = await this.db.query.documentLinks.findMany({
        where: and(eq(documentLinks.organizationId, orgId), eq(documentLinks.entityType, opts.entityType), eq(documentLinks.entityId, opts.entityId)),
        columns: { documentId: true },
      });
      const ids = links.map((l) => l.documentId);
      const parts = [];
      if (ids.length) parts.push(inArray(documents.id, ids));
      if (opts.entityType === "project") parts.push(eq(documents.projectId, opts.entityId));
      if (!parts.length) return [];
      scope = parts.length === 1 ? parts[0] : or(...parts);
    }
    const rows = await this.db.query.documents.findMany({
      where: and(
        eq(documents.organizationId, orgId),
        isNull(documents.archivedAt),
        ...(opts.projectId ? [eq(documents.projectId, opts.projectId)] : []),
        ...(scope ? [scope] : []),
        ...(q ? [or(ilike(documents.title, `%${q}%`), ilike(documents.body, `%${q}%`))] : []),
      ),
      with: { project: true, updatedBy: true, accessList: true },
      orderBy: desc(documents.updatedAt),
    });
    const ctx = viewer ? await this.viewerContext(orgId, viewer) : null;
    return rows
      .filter((d) => !ctx || this.canSee(d, ctx))
      .map((d) => ({
      id: d.id,
      title: d.title,
      icon: d.icon,
      cover: d.cover,
      parentId: d.parentId,
      access: d.access,
      excerpt: d.body.replace(/\s+/g, " ").trim().slice(0, 160),
      project: d.project ? { id: d.project.id, name: d.project.name } : null,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy ? { id: d.updatedBy.id, name: d.updatedBy.name } : null,
    }));
  }

  async get(orgId: string, id: string, viewer?: Viewer) {
    const row = await this.db.query.documents.findFirst({
      where: and(eq(documents.id, id), eq(documents.organizationId, orgId)),
      with: {
        project: true,
        createdBy: true,
        updatedBy: true,
        accessList: { with: { user: { columns: { id: true, name: true } } } },
        parent: { columns: { id: true, title: true, icon: true } },
        children: {
          columns: { id: true, title: true, icon: true, updatedAt: true },
          where: isNull(documents.archivedAt),
          orderBy: documents.createdAt,
        },
      },
    });
    if (!row) throw new NotFoundException("Document not found");
    if (viewer) {
      const ctx = await this.viewerContext(orgId, viewer);
      if (!this.canSee(row, ctx)) throw new ForbiddenException("You don't have access to this document");
    }
    const links = await this.linksFor(orgId, id);
    const { accessList, ...rest } = row;
    return {
      ...rest,
      links,
      accessUsers: accessList.filter((a) => a.user).map((a) => ({ id: a.user!.id, name: a.user!.name })),
      accessRoles: accessList.map((a) => a.role).filter((x): x is string => Boolean(x)),
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

  /* ---------------- Row 62: permissions ---------------- */

  /** What the viewer belongs to: admin flag + the projects they're on (member, lead or creator). */
  private async viewerContext(orgId: string, viewer: Viewer) {
    const admin = viewer.role === "owner" || viewer.role === "admin";
    const [memberOf, ledOrMade] = await Promise.all([
      this.db.query.projectMembers.findMany({ where: and(eq(projectMembers.organizationId, orgId), eq(projectMembers.userId, viewer.userId)), columns: { projectId: true } }),
      this.db.query.projects.findMany({ where: and(eq(projects.organizationId, orgId), or(eq(projects.leadId, viewer.userId), eq(projects.createdById, viewer.userId))), columns: { id: true } }),
    ]);
    return { userId: viewer.userId, role: viewer.role, admin, projectIds: new Set([...memberOf.map((m) => m.projectId), ...ledOrMade.map((p) => p.id)]) };
  }

  private canSee(
    d: { projectId: string | null; createdById: string | null; access: "default" | "restricted"; accessList: { userId: string | null; role: string | null }[] },
    ctx: { userId: string; role: Role; admin: boolean; projectIds: Set<string> },
  ) {
    if (ctx.admin || d.createdById === ctx.userId) return true;
    if (d.access === "restricted") return d.accessList.some((a) => a.userId === ctx.userId || (a.role && a.role === ctx.role));
    if (d.projectId) return ctx.projectIds.has(d.projectId);
    return true;
  }

  /** Author or admin sets who can open the doc. */
  async setAccess(orgId: string, actor: Viewer, id: string, dto: { access: "default" | "restricted"; userIds?: string[]; roles?: string[] }) {
    const doc = await this.get(orgId, id);
    const admin = actor.role === "owner" || actor.role === "admin";
    if (doc.createdBy?.id !== actor.userId && !admin) throw new ForbiddenException("Only the author or an admin can change access");
    await this.db.transaction(async (tx) => {
      await tx.update(documents).set({ access: dto.access, updatedAt: new Date() }).where(eq(documents.id, id));
      await tx.delete(documentAccess).where(eq(documentAccess.documentId, id));
      if (dto.access === "restricted") {
        const rows = [
          ...[...new Set(dto.userIds ?? [])].map((userId) => ({ organizationId: orgId, documentId: id, userId, role: null })),
          ...[...new Set(dto.roles ?? [])].filter((x) => ["owner", "admin", "member", "guest"].includes(x)).map((role) => ({ organizationId: orgId, documentId: id, userId: null, role })),
        ];
        if (rows.length) await tx.insert(documentAccess).values(rows);
      }
    });
    return this.get(orgId, id);
  }

  /* ---------------- Row 61: links to records ---------------- */

  /** The records this doc is attached to, with a label for each. */
  private async linksFor(orgId: string, docId: string) {
    const rows = await this.db.query.documentLinks.findMany({ where: and(eq(documentLinks.documentId, docId), eq(documentLinks.organizationId, orgId)) });
    const out: { id: string; entityType: DocLinkEntity; entityId: string; label: string }[] = [];
    for (const l of rows) {
      out.push({ id: l.id, entityType: l.entityType, entityId: l.entityId, label: await this.entityLabel(orgId, l.entityType, l.entityId) });
    }
    return out;
  }

  private async entityLabel(orgId: string, type: DocLinkEntity, id: string) {
    if (type === "project") {
      const p = await this.db.query.projects.findFirst({ where: and(eq(projects.id, id), eq(projects.organizationId, orgId)), columns: { name: true } });
      return p?.name ?? "Project";
    }
    if (type === "task") {
      const t = await this.db.query.tasks.findFirst({ where: and(eq(tasks.id, id), eq(tasks.organizationId, orgId)), columns: { title: true, reference: true } });
      return t ? `${t.reference ? `${t.reference} ` : ""}${t.title}` : "Task";
    }
    if (type === "company") {
      const c = await this.db.query.companies.findFirst({ where: and(eq(companies.id, id), eq(companies.organizationId, orgId)), columns: { name: true } });
      return c?.name ?? "Client";
    }
    const d = await this.db.query.deals.findFirst({ where: and(eq(deals.id, id), eq(deals.organizationId, orgId)), columns: { title: true } });
    return d?.title ?? "Deal";
  }

  async addLink(orgId: string, userId: string, docId: string, entityType: DocLinkEntity, entityId: string) {
    await this.get(orgId, docId);
    const label = await this.entityLabel(orgId, entityType, entityId);
    // A label equal to the generic word means the lookup found nothing in this org.
    if (["Project", "Task", "Client", "Deal"].includes(label)) throw new BadRequestException("That record isn't in this workspace");
    await this.db
      .insert(documentLinks)
      .values({ organizationId: orgId, documentId: docId, entityType, entityId, createdById: userId })
      .onConflictDoNothing();
    return this.get(orgId, docId);
  }

  async removeLink(orgId: string, docId: string, linkId: string) {
    await this.db.delete(documentLinks).where(and(eq(documentLinks.id, linkId), eq(documentLinks.documentId, docId), eq(documentLinks.organizationId, orgId)));
    return this.get(orgId, docId);
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
