import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, isNull, or, gt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, deals, documentAccess, documentLinks, documentStars, documentVisits, documents, projectMembers, projects, tasks, type DocumentSettings } from "../../db/schema.js";
import type { Role } from "../auth/auth.types.js";
import { ChatEventsService } from "../chat/chat-events.service.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService, pendingApproval } from "../notifications/notifications.service.js";
import { notifications } from "../../db/schema.js";
import { randomBytes } from "node:crypto";
import { expandSnippets, snippetIds, stripInternal, textOf, toLines, type PmNode } from "./doc-content.js";
import { renderDocPdf } from "../crm/pdf.js";
import { organizations } from "../../db/schema.js";
import { SnippetsService } from "./snippets.service.js";

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
  /** Row 119 */
  clientVisible?: boolean;
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly chatEvents: ChatEventsService,
    private readonly notifications: NotificationsService,
    private readonly snippets: SnippetsService,
    private readonly activity: ActivityService,
  ) {}

  /** Row 65 + 66: what leaves the team — internal blocks gone, snippets expanded. */
  async exportContent(orgId: string, content: Record<string, unknown> | null) {
    if (!content) return null;
    const stripped = stripInternal(content as PmNode);
    const ids = [...snippetIds(stripped)];
    const lookup = await this.snippets.contentsFor(orgId, ids);
    return expandSnippets(stripped, lookup);
  }

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
      with: { project: true, updatedBy: true, accessList: true, approver: { columns: { id: true, name: true } } },
      orderBy: desc(documents.updatedAt),
    });
    const ctx = viewer ? await this.viewerContext(orgId, viewer) : null;
    const stars = viewer ? await this.starSet(viewer.userId) : new Set<string>();
    return rows
      .filter((d) => !ctx || this.canSee(d, ctx))
      .map((d) => ({
      id: d.id,
      starred: stars.has(d.id),
      title: d.title,
      icon: d.icon,
      cover: d.cover,
      parentId: d.parentId,
      access: d.access,
      supersededById: d.supersededById,
      reviewStatus: d.reviewStatus,
      approver: d.approver ? { id: d.approver.id, name: d.approver.name } : null,
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
        approver: { columns: { id: true, name: true } },
        reviewRequestedBy: { columns: { id: true, name: true } },
        supersededBy: { columns: { id: true, title: true, icon: true } },
        supersedes: { columns: { id: true, title: true, icon: true, effectiveFrom: true }, where: isNull(documents.archivedAt) },
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
    const starred = viewer ? (await this.starSet(viewer.userId)).has(id) : false;
    const { accessList, approver, reviewRequestedBy, ...rest } = row;
    return {
      ...rest,
      links,
      starred,
      approver: approver ? { id: approver.id, name: approver.name } : null,
      reviewRequestedBy: reviewRequestedBy ? { id: reviewRequestedBy.id, name: reviewRequestedBy.name } : null,
      accessUsers: accessList.filter((a) => a.user).map((a) => ({ id: a.user!.id, name: a.user!.name })),
      accessRoles: accessList.map((a) => a.role).filter((x): x is string => Boolean(x)),
      project: row.project ? { id: row.project.id, name: row.project.name } : null,
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
      updatedBy: row.updatedBy ? { id: row.updatedBy.id, name: row.updatedBy.name } : null,
    };
  }

  /** Row 77: what a doc's followers hear about. Edits are coalesced to one ping per editor per hour. */
  private async pingFollowers(orgId: string, actorId: string, id: string, verb: "doc_edited" | "doc_shared" | "doc_superseded" | "doc_review_requested" | "doc_approved" | "doc_rejected", title: string, body?: string | null, exclude?: string[]) {
    if (verb === "doc_edited") {
      const recent = await this.db.query.notifications.findFirst({
        where: and(eq(notifications.entityId, id), eq(notifications.verb, "doc_edited"), eq(notifications.triggeredById, actorId), gt(notifications.createdAt, new Date(Date.now() - 60 * 60 * 1000))),
      });
      if (recent) return;
    }
    await this.notifications.notifyFollowers({ orgId, entityType: "document", entityId: id, actorId, verb, title, body, data: { documentId: id }, exclude });
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
    await this.activity.record({ orgId, actorId: userId, entityType: "document", entityId: row!.id, action: "created" });
    // Row 50: a doc filed under a project is shared with its channel.
    if (row!.projectId) {
      await this.chatEvents.postProjectEvent(orgId, row!.projectId, userId, {
        type: "doc_shared",
        text: `shared the doc “${row!.title || "Untitled"}”`,
        link: `/docs/${row!.id}`,
        entityId: row!.id,
      });
    }
    // Row 77: the author follows their own doc.
    await this.notifications.follow(orgId, userId, "document", row!.id, "created");
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: DocumentWrite) {
    const current = await this.get(orgId, id);
    if (dto.parentId) {
      if (dto.parentId === id) throw new BadRequestException("A document cannot be its own parent");
      await this.assertNotDescendant(orgId, id, dto.parentId);
    }
    const settings = dto.settings ? { ...current.settings, ...dto.settings } : undefined;
    // Row 63: an approved doc that changes is no longer the approved version.
    const contentChanged = (dto.content !== undefined && JSON.stringify(dto.content) !== JSON.stringify(current.content)) || (dto.body !== undefined && dto.body !== current.body) || (dto.title !== undefined && dto.title !== current.title);
    const reopen = current.reviewStatus === "approved" && contentChanged ? { reviewStatus: "draft" as const, reviewNote: "Edited after approval — needs sign-off again." } : {};
    await this.db
      .update(documents)
      .set({ ...dto, settings, ...reopen, updatedById: userId, updatedAt: new Date() })
      .where(eq(documents.id, id));
    if (contentChanged) {
      // Row 102: one activity row per edit; the project feed shows the latest per editor.
      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "document",
        entityId: id,
        action: "edited",
        changes: dto.title && dto.title !== current.title ? [{ field: "title", from: current.title, to: dto.title }] : [],
      });
    }
    if (contentChanged) await this.pingFollowers(orgId, userId, id, "doc_edited", current.title, dto.title && dto.title !== current.title ? `Renamed to "${dto.title}"` : "Content changed");
    return this.get(orgId, id);
  }

  /* ---------------- Row 70: supersede ---------------- */

  /** Mark `id` as replaced by `byDocumentId` from `effectiveFrom` (default now). The old doc stays readable. */
  async supersede(orgId: string, actor: Viewer, id: string, byDocumentId: string, effectiveFrom?: string | null) {
    if (byDocumentId === id) throw new BadRequestException("A doc can't supersede itself");
    await this.get(orgId, id, actor);
    const newer = await this.get(orgId, byDocumentId, actor);
    if (newer.supersededById === id) throw new BadRequestException("That doc is already superseded by this one");
    await this.db
      .update(documents)
      .set({ supersededById: byDocumentId, supersededAt: new Date(), effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(), updatedById: actor.userId, updatedAt: new Date() })
      .where(eq(documents.id, id));
    await this.pingFollowers(orgId, actor.userId, id, "doc_superseded", newer.title, `Replaces this doc${effectiveFrom ? ` from ${new Date(effectiveFrom).toLocaleDateString()}` : ""}`);
    return this.get(orgId, id, actor);
  }

  async unsupersede(orgId: string, actor: Viewer, id: string) {
    await this.get(orgId, id, actor);
    await this.db.update(documents).set({ supersededById: null, supersededAt: null, effectiveFrom: null, updatedAt: new Date() }).where(eq(documents.id, id));
    return this.get(orgId, id, actor);
  }

  /* ---------------- Row 69: recent & starred ---------------- */

  async recordVisit(orgId: string, userId: string, documentId: string) {
    await this.db
      .insert(documentVisits)
      .values({ organizationId: orgId, userId, documentId, lastOpenedAt: new Date() })
      .onConflictDoUpdate({ target: [documentVisits.documentId, documentVisits.userId], set: { lastOpenedAt: new Date() } });
  }

  async toggleStar(orgId: string, userId: string, documentId: string) {
    const existing = await this.db.query.documentStars.findFirst({ where: and(eq(documentStars.documentId, documentId), eq(documentStars.userId, userId)) });
    if (existing) {
      await this.db.delete(documentStars).where(and(eq(documentStars.documentId, documentId), eq(documentStars.userId, userId)));
      return { documentId, starred: false };
    }
    await this.get(orgId, documentId);
    await this.db.insert(documentStars).values({ organizationId: orgId, userId, documentId }).onConflictDoNothing();
    return { documentId, starred: true };
  }

  /** My last-opened docs (visible to me), newest first. */
  async recent(orgId: string, viewer: Viewer, limit = 8) {
    const visits = await this.db.query.documentVisits.findMany({
      where: and(eq(documentVisits.organizationId, orgId), eq(documentVisits.userId, viewer.userId)),
      orderBy: [desc(documentVisits.lastOpenedAt)],
      limit: limit * 3,
    });
    if (!visits.length) return [];
    const order = new Map(visits.map((v, i) => [v.documentId, i]));
    const rows = await this.list(orgId, {}, viewer);
    return rows
      .filter((d) => order.has(d.id))
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .slice(0, limit)
      .map((d) => ({ ...d, lastOpenedAt: visits.find((v) => v.documentId === d.id)!.lastOpenedAt }));
  }

  async starred(orgId: string, viewer: Viewer) {
    const stars = await this.db.query.documentStars.findMany({ where: and(eq(documentStars.organizationId, orgId), eq(documentStars.userId, viewer.userId)) });
    if (!stars.length) return [];
    const ids = new Set(stars.map((s) => s.documentId));
    const rows = await this.list(orgId, {}, viewer);
    return rows.filter((d) => ids.has(d.id)).map((d) => ({ ...d, starred: true }));
  }

  /** Star flags for a viewer, folded into list/get payloads. */
  private async starSet(userId: string) {
    const stars = await this.db.query.documentStars.findMany({ where: eq(documentStars.userId, userId), columns: { documentId: true } });
    return new Set(stars.map((s) => s.documentId));
  }

  /* ---------------- Row 67: branded PDF ---------------- */

  /** The doc as a branded PDF: internal blocks stripped, snippets expanded, org colour band + footer. */
  async pdf(orgId: string, id: string, viewer?: Viewer) {
    const doc = await this.get(orgId, id, viewer);
    return this.renderPdfFor(orgId, doc);
  }

  async publicPdf(token: string) {
    const row = await this.db.query.documents.findFirst({ where: and(eq(documents.shareToken, token), isNull(documents.archivedAt)) });
    if (!row) throw new NotFoundException("This link is not valid");
    return this.renderPdfFor(row.organizationId, { title: row.title, content: row.content, body: row.body, updatedAt: row.updatedAt, reviewStatus: row.reviewStatus, projectId: row.projectId });
  }

  private async renderPdfFor(orgId: string, doc: { title: string; content: Record<string, unknown> | null; body: string; updatedAt: Date; reviewStatus: string; projectId: string | null }) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true, brandColor: true, brandFooter: true } });
    const project = doc.projectId ? await this.db.query.projects.findFirst({ where: eq(projects.id, doc.projectId), columns: { name: true } }) : null;
    const content = await this.exportContent(orgId, doc.content);
    const lines = content ? toLines(content as PmNode) : doc.body.split(/\r?\n/).map((t) => ({ text: t, style: t ? ("p" as const) : ("blank" as const) }));
    const bytes = renderDocPdf({
      title: doc.title || "Untitled",
      subtitle: [project?.name, doc.reviewStatus === "approved" ? "Approved" : null, `Updated ${doc.updatedAt.toISOString().slice(0, 10)}`].filter(Boolean).join("  ·  "),
      lines,
      brand: { color: org?.brandColor ?? "#6366f1", orgName: org?.name ?? "", footer: org?.brandFooter ?? null },
    });
    const filename = `${(doc.title || "document").replace(/[^\w.-]+/g, "_").slice(0, 80)}.pdf`;
    return { bytes, filename };
  }

  /* ---------------- Row 65: share link (internal blocks stripped) ---------------- */

  async enableShare(orgId: string, actor: Viewer, id: string) {
    const doc = await this.get(orgId, id, actor);
    if (doc.shareToken) return doc;
    await this.db.update(documents).set({ shareToken: randomBytes(20).toString("hex"), sharedAt: new Date(), updatedAt: new Date() }).where(eq(documents.id, id));
    return this.get(orgId, id);
  }

  async disableShare(orgId: string, actor: Viewer, id: string) {
    await this.get(orgId, id, actor);
    await this.db.update(documents).set({ shareToken: null, sharedAt: null, updatedAt: new Date() }).where(eq(documents.id, id));
    return this.get(orgId, id);
  }

  /** What a client sees from a share link: the doc without internal-only blocks. */
  async publicByToken(token: string) {
    const row = await this.db.query.documents.findFirst({
      where: and(eq(documents.shareToken, token), isNull(documents.archivedAt)),
      with: { project: { columns: { name: true } }, organization: { columns: { name: true } } },
    });
    if (!row) throw new NotFoundException("This link is not valid");
    const content = await this.exportContent(row.organizationId, row.content);
    return {
      title: row.title,
      icon: row.icon,
      settings: row.settings,
      content,
      body: content ? textOf(content) : row.body,
      updatedAt: row.updatedAt,
      project: row.project?.name ?? null,
      organization: row.organization?.name ?? null,
      reviewStatus: row.reviewStatus,
    };
  }

  /* ---------------- Row 63: review & sign-off ---------------- */

  /** Ask a named approver to sign the doc off; they get an inbox item. */
  async requestReview(orgId: string, actor: Viewer, id: string, approverId: string, note?: string) {
    const doc = await this.get(orgId, id, actor);
    const patch = { reviewStatus: "in_review" as const, approverId, reviewRequestedById: actor.userId, reviewRequestedAt: new Date(), approvedAt: null, reviewNote: note?.trim() || null, updatedAt: new Date() };
    await this.db.update(documents).set(patch).where(eq(documents.id, id));
    await this.notifications.notifyDirect({
      orgId,
      receiverId: approverId,
      actorId: actor.userId,
      entityType: "document",
      entityId: id,
      verb: "doc_review_requested",
      title: `Review requested: ${doc.title}`,
      body: note?.trim() || "Please review and sign off",
      data: { documentId: id, approval: pendingApproval("doc_review") },
    });
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "document", entityId: id, action: "review_requested" });
    await this.pingFollowers(orgId, actor.userId, id, "doc_review_requested", doc.title, "Sent for review", [approverId]);
    return this.get(orgId, id);
  }

  /** Row 75: inbox cards decide doc reviews through here. */
  onModuleInit() {
    this.notifications.registerApproval("doc_review", (d) =>
      this.decideReview(d.orgId, { userId: d.userId, role: d.role as Viewer["role"] }, d.entityId, d.approve, d.note),
    );
  }

  /** The approver (or an admin) approves, or sends it back to Draft with a note. */
  async decideReview(orgId: string, actor: Viewer, id: string, approve: boolean, note?: string) {
    const doc = await this.get(orgId, id, actor);
    const admin = actor.role === "owner" || actor.role === "admin";
    if (doc.approverId !== actor.userId && !admin) throw new ForbiddenException("Only the named approver can sign this off");
    if (doc.reviewStatus !== "in_review") throw new BadRequestException("This doc isn't waiting for review");
    const now = new Date();
    await this.db
      .update(documents)
      .set(approve ? { reviewStatus: "approved", approvedAt: now, approverId: actor.userId, reviewNote: note?.trim() || null, updatedAt: now } : { reviewStatus: "draft", approvedAt: null, reviewNote: note?.trim() || "Sent back for changes", updatedAt: now })
      .where(eq(documents.id, id));
    // Row 75: flip the inbox card(s) whether this came from the doc page or the inbox.
    await this.notifications.resolveApproval("document", id, approve ? "approved" : "rejected", note, actor.userId);
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "document", entityId: id, action: approve ? "approved" : "rejected" });
    await this.pingFollowers(orgId, actor.userId, id, approve ? "doc_approved" : "doc_rejected", doc.title, note?.trim() || (approve ? "Signed off" : "Sent back for changes"), [doc.reviewRequestedBy?.id, doc.createdBy?.id].filter((x): x is string => Boolean(x)));
    const receivers = new Set([doc.reviewRequestedBy?.id, doc.createdBy?.id].filter((x): x is string => Boolean(x) && x !== actor.userId));
    for (const receiverId of receivers) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId,
        actorId: actor.userId,
        entityType: "document",
        entityId: id,
        verb: approve ? "doc_approved" : "doc_rejected",
        title: `${approve ? "Approved" : "Sent back"}: ${doc.title}`,
        body: note?.trim() || (approve ? "Signed off" : "Needs changes"),
        data: { documentId: id },
      });
    }
    if (approve && doc.projectId) {
      await this.chatEvents.postProjectEvent(orgId, doc.projectId, actor.userId, { type: "doc_shared", text: `approved the doc “${doc.title}”`, link: `/docs/${id}`, entityId: id });
    }
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
