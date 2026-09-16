import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { contacts, documents, invoices, lists, milestones, organizations, portalAccess, portalEvents, projectStages, projects, statuses, tasks, users } from "../../db/schema.js";
import { DocumentsService } from "../documents/documents.service.js";
import { textOf } from "../documents/doc-content.js";
import { MailerService } from "../notifications/mailer.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { ActivityService } from "../activity/activity.service.js";
import { webBase } from "../integrations/integrations.service.js";

export type PortalDecision = "approved" | "changes_requested";

/**
 * Row 118: the client's read-only view of a project. Only what is marked
 * client-visible leaves the team: stage names + status, flagged milestones,
 * flagged tasks (title, status, due) and flagged docs (internal blocks
 * stripped). Never hours, rates, comments, chat, assignees or estimates.
 */
@Injectable()
export class PortalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly documents: DocumentsService,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  /* ---------------- Row 120: guest access links ---------------- */

  private accessRow(a: typeof portalAccess.$inferSelect & { invitedBy?: { id: string; name: string } | null }) {
    const now = Date.now();
    const status = a.revokedAt ? "revoked" : a.expiresAt && a.expiresAt.getTime() < now ? "expired" : "active";
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      contactId: a.contactId,
      projectIds: a.projectIds,
      status,
      expiresAt: a.expiresAt?.toISOString() ?? null,
      revokedAt: a.revokedAt?.toISOString() ?? null,
      invitedBy: a.invitedBy ?? null,
      lastSentAt: a.lastSentAt?.toISOString() ?? null,
      lastOpenedAt: a.lastOpenedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      link: `${webBase()}/portal/${a.token}`,
    };
  }

  async listAccess(orgId: string, projectId?: string) {
    const rows = await this.db.query.portalAccess.findMany({ where: eq(portalAccess.organizationId, orgId), with: { invitedBy: { columns: { id: true, name: true } } }, orderBy: [desc(portalAccess.createdAt)] });
    return rows.filter((a) => !projectId || a.projectIds.includes(projectId)).map((a) => this.accessRow(a));
  }

  async createAccess(orgId: string, userId: string, dto: { email: string; name?: string | null; projectIds: string[]; expiresAt?: string | null; contactId?: string | null; send?: boolean }) {
    const email = dto.email.trim().toLowerCase();
    if (!email.includes("@")) throw new BadRequestException("A valid email is required");
    const owned = await this.db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.organizationId, orgId), inArray(projects.id, dto.projectIds)));
    if (!owned.length) throw new BadRequestException("Pick at least one project");
    let name = dto.name?.trim() || null;
    if (!name) {
      const c = await this.db.query.contacts.findFirst({ where: and(eq(contacts.organizationId, orgId), eq(contacts.email, email)), columns: { firstName: true, lastName: true } });
      if (c) name = [c.firstName, c.lastName].filter(Boolean).join(" ");
    }
    const [row] = await this.db
      .insert(portalAccess)
      .values({
        organizationId: orgId,
        email,
        name,
        contactId: dto.contactId ?? null,
        projectIds: owned.map((p) => p.id),
        token: randomBytes(24).toString("base64url"),
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        invitedById: userId,
      })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "invitation", entityId: row!.id, action: "guest_invited", changes: [{ field: "email", from: null, to: email }, { field: "projects", from: null, to: owned.map((p) => p.name).join(", ") }, ...(row!.expiresAt ? [{ field: "expiresAt", from: null, to: row!.expiresAt.toISOString() }] : [])] });
    if (dto.send !== false) await this.sendAccess(orgId, row!.id, userId);
    return this.accessRow({ ...(await this.db.query.portalAccess.findFirst({ where: eq(portalAccess.id, row!.id), with: { invitedBy: { columns: { id: true, name: true } } } }))! });
  }

  async sendAccess(orgId: string, id: string, userId: string) {
    const a = await this.db.query.portalAccess.findFirst({ where: and(eq(portalAccess.id, id), eq(portalAccess.organizationId, orgId)), with: { invitedBy: { columns: { id: true, name: true } } } });
    if (!a) throw new NotFoundException("Access link not found");
    if (a.revokedAt) throw new BadRequestException("This link was revoked - create a new one");
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true } });
    const named = await this.db.select({ name: projects.name }).from(projects).where(inArray(projects.id, a.projectIds));
    const [sender] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
    await this.mailer.send({
      to: a.email,
      subject: `${sender?.name ?? "Your project manager"} shared the ${org?.name ?? ""} client portal with you`,
      text: `Hi${a.name ? ` ${a.name}` : ""},

You can follow ${named.map((p) => p.name).join(", ")} here - stage progress, milestones, shared documents and anything waiting on your approval.${a.expiresAt ? `

This link works until ${a.expiresAt.toLocaleDateString()}.` : ""}

Keep the link private; it is your access.`,
      link: `/portal/${a.token}`,
    });
    await this.db.update(portalAccess).set({ lastSentAt: new Date() }).where(eq(portalAccess.id, id));
    return this.accessRow({ ...a, lastSentAt: new Date() });
  }

  async revokeAccess(orgId: string, id: string, userId: string) {
    const rows = await this.db.update(portalAccess).set({ revokedAt: new Date() }).where(and(eq(portalAccess.id, id), eq(portalAccess.organizationId, orgId))).returning({ email: portalAccess.email });
    if (!rows.length) throw new NotFoundException("Access link not found");
    await this.activity.record({ orgId, actorId: userId, entityType: "invitation", entityId: id, action: "guest_revoked", changes: [{ field: "email", from: rows[0]!.email, to: null }] });
    return { id, revoked: true };
  }

  /** Validate a guest token for a project (or any project when projectId is omitted). */
  async resolveToken(token: string, projectId?: string) {
    const a = await this.db.query.portalAccess.findFirst({ where: eq(portalAccess.token, token) });
    if (!a || a.revokedAt) throw new NotFoundException("This link isn't valid any more");
    if (a.expiresAt && a.expiresAt.getTime() < Date.now()) throw new ForbiddenException("This link has expired - ask your project manager for a new one");
    if (projectId && !a.projectIds.includes(projectId)) throw new NotFoundException("Project not found");
    return a;
  }

  /* ---------------- Row 122: engagement ---------------- */

  private async logEvent(a: typeof portalAccess.$inferSelect, projectId: string | null, kind: string, extra: { entityType?: string; entityId?: string; label?: string; note?: string } = {}) {
    await this.db.insert(portalEvents).values({ organizationId: a.organizationId, accessId: a.id, projectId, email: a.email, kind, entityType: extra.entityType ?? null, entityId: extra.entityId ?? null, label: extra.label ?? null, note: extra.note ?? null });
    await this.db.update(portalAccess).set({ lastOpenedAt: new Date() }).where(eq(portalAccess.id, a.id));
  }

  async engagement(orgId: string, projectId: string, limit = 100) {
    const rows = await this.db.query.portalEvents.findMany({ where: and(eq(portalEvents.organizationId, orgId), eq(portalEvents.projectId, projectId)), orderBy: [desc(portalEvents.createdAt)], limit });
    const accessIds = [...new Set(rows.map((e) => e.accessId).filter((x): x is string => Boolean(x)))];
    const people = accessIds.length ? await this.db.select({ id: portalAccess.id, name: portalAccess.name, email: portalAccess.email }).from(portalAccess).where(inArray(portalAccess.id, accessIds)) : [];
    const who = new Map(people.map((p) => [p.id, p.name || p.email]));
    return rows.map((e) => ({ id: e.id, kind: e.kind, who: (e.accessId && who.get(e.accessId)) || e.email || "Guest", entityType: e.entityType, entityId: e.entityId, label: e.label, note: e.note, createdAt: e.createdAt.toISOString() }));
  }

  /* ---------------- guest-facing (token) ---------------- */

  async guestHome(token: string) {
    const a = await this.resolveToken(token);
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, a.organizationId), columns: { name: true, brandColor: true, brandLogoUrl: true, brandFooter: true } });
    const rows = a.projectIds.length ? await this.db.select({ id: projects.id, name: projects.name, color: projects.color, status: projects.status }).from(projects).where(and(inArray(projects.id, a.projectIds), isNull(projects.archivedAt))) : [];
    await this.logEvent(a, rows.length === 1 ? rows[0]!.id : null, "opened");
    const billing = await this.invoicesFor(a);
    return { guest: { name: a.name, email: a.email, expiresAt: a.expiresAt?.toISOString() ?? null }, organization: org, projects: rows, ...billing };
  }

  /**
   * Row 129: the client's invoices and balance, next to the work. An invoice
   * belongs on this guest's portal when it is on one of their projects or
   * billed to the company their contact record belongs to. Drafts never show;
   * paid ones stay for the record.
   */
  private async invoicesFor(a: typeof portalAccess.$inferSelect, projectId?: string) {
    const contact = a.contactId ? await this.db.query.contacts.findFirst({ where: eq(contacts.id, a.contactId), columns: { companyId: true } }) : null;
    const scope = projectId
      ? eq(invoices.projectId, projectId)
      : or(a.projectIds.length ? inArray(invoices.projectId, a.projectIds) : sql`false`, contact?.companyId ? eq(invoices.companyId, contact.companyId) : sql`false`);
    const rows = await this.db.query.invoices.findMany({
      where: and(eq(invoices.organizationId, a.organizationId), isNull(invoices.archivedAt), notInArray(invoices.status, ["draft", "void"]), scope),
      orderBy: [desc(invoices.issueDate)],
      columns: { id: true, number: true, title: true, status: true, currency: true, issueDate: true, dueDate: true, total: true, amountPaid: true, token: true, paidAt: true, projectId: true },
      limit: 100,
    });
    const now = Date.now();
    const list = rows.map((r) => {
      const balanceDue = Math.round(Math.max(0, r.total - r.amountPaid) * 100) / 100;
      return {
        id: r.id,
        number: r.number,
        title: r.title,
        status: r.status,
        currency: r.currency,
        issueDate: r.issueDate.toISOString(),
        dueDate: r.dueDate?.toISOString() ?? null,
        paidAt: r.paidAt?.toISOString() ?? null,
        total: r.total,
        amountPaid: r.amountPaid,
        balanceDue,
        overdue: balanceDue > 0 && Boolean(r.dueDate && r.dueDate.getTime() < now),
        token: r.token,
        projectId: r.projectId,
      };
    });
    const byCurrency = new Map<string, { outstanding: number; overdue: number }>();
    for (const i of list) {
      const c = byCurrency.get(i.currency) ?? { outstanding: 0, overdue: 0 };
      c.outstanding += i.balanceDue;
      if (i.overdue) c.overdue += i.balanceDue;
      byCurrency.set(i.currency, c);
    }
    return {
      invoices: list,
      balances: [...byCurrency.entries()].map(([currency, c]) => ({ currency, outstanding: Math.round(c.outstanding * 100) / 100, overdue: Math.round(c.overdue * 100) / 100 })),
    };
  }

  async guestProject(token: string, projectId: string) {
    const a = await this.resolveToken(token, projectId);
    const view = await this.projectView(a.organizationId, projectId);
    await this.logEvent(a, projectId, "opened", { label: view.project.name });
    return { ...view, ...(await this.invoicesFor(a, projectId)) };
  }

  async guestDoc(token: string, projectId: string, docId: string) {
    const a = await this.resolveToken(token, projectId);
    const doc = await this.doc(a.organizationId, projectId, docId);
    await this.logEvent(a, projectId, "viewed_doc", { entityType: "document", entityId: docId, label: doc.title });
    return doc;
  }

  /** Row 121: one-click approve / request changes on a milestone or a shared doc. */
  async guestDecide(token: string, projectId: string, dto: { kind: "milestone" | "document"; id: string; decision: PortalDecision; note?: string }) {
    const a = await this.resolveToken(token, projectId);
    const orgId = a.organizationId;
    const who = a.name ? `${a.name} (${a.email})` : a.email;
    const note = dto.note?.trim() || null;
    const now = new Date();
    let label = "";
    let receivers: string[] = [];
    const project = await this.db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { name: true, leadId: true } });
    if (dto.kind === "milestone") {
      const m = await this.db.query.milestones.findFirst({ where: and(eq(milestones.id, dto.id), eq(milestones.projectId, projectId), eq(milestones.clientVisible, true), isNull(milestones.archivedAt)) });
      if (!m) throw new NotFoundException("Milestone not found");
      await this.db.update(milestones).set({ clientDecision: dto.decision, clientDecidedAt: now, clientDecidedBy: who, clientDecisionNote: note, updatedAt: now }).where(eq(milestones.id, m.id));
      label = m.name;
      receivers = [project?.leadId, m.signoffRequestedById, m.createdById].filter((x): x is string => Boolean(x));
    } else {
      const d = await this.db.query.documents.findFirst({ where: and(eq(documents.id, dto.id), eq(documents.projectId, projectId), eq(documents.clientVisible, true), isNull(documents.archivedAt)) });
      if (!d) throw new NotFoundException("Document not found");
      await this.db.update(documents).set({ clientDecision: dto.decision, clientDecidedAt: now, clientDecidedBy: who, clientDecisionNote: note, updatedAt: now }).where(eq(documents.id, d.id));
      label = d.title || "Untitled";
      receivers = [project?.leadId, d.reviewRequestedById, d.createdById].filter((x): x is string => Boolean(x));
    }
    await this.logEvent(a, projectId, dto.decision, { entityType: dto.kind, entityId: dto.id, label, note: note ?? undefined });
    await this.activity.record({ orgId, actorId: null, entityType: dto.kind, entityId: dto.id, action: dto.decision === "approved" ? "client_approved" : "client_changes_requested", changes: [{ field: "by", from: null, to: who }, ...(note ? [{ field: "note", from: null, to: note }] : [])] });
    const approved = dto.decision === "approved";
    for (const receiverId of [...new Set(receivers)]) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId,
        entityType: dto.kind,
        entityId: dto.id,
        verb: approved ? "client_approved" : "client_changes_requested",
        title: `${approved ? "Client approved" : "Client requested changes"}: ${label}`,
        body: `${who} · ${project?.name ?? ""}${note ? ` · “${note}”` : ""}`,
        data: { projectId, kind: dto.kind, decision: dto.decision, by: who },
      });
    }
    return { ok: true, decision: dto.decision, decidedAt: now.toISOString() };
  }

  async projectView(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId), isNull(projects.archivedAt)),
      with: { lead: { columns: { name: true } }, company: { columns: { name: true } } },
    });
    if (!project) throw new NotFoundException("Project not found");
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true, brandColor: true, brandLogoUrl: true, brandFooter: true } });
    const [stageRows, msRows, docRows] = await Promise.all([
      this.db.query.projectStages.findMany({ where: and(eq(projectStages.projectId, projectId), isNull(projectStages.archivedAt)), orderBy: [asc(projectStages.position), asc(projectStages.createdAt)] }),
      this.db.query.milestones.findMany({ where: and(eq(milestones.projectId, projectId), eq(milestones.clientVisible, true), isNull(milestones.archivedAt)), orderBy: [asc(milestones.targetDate), asc(milestones.createdAt)] }),
      this.db.query.documents.findMany({ where: and(eq(documents.projectId, projectId), eq(documents.clientVisible, true), isNull(documents.archivedAt)), orderBy: [asc(documents.title)], columns: { id: true, title: true, icon: true, updatedAt: true, reviewStatus: true, shareToken: true, clientDecision: true, clientDecidedAt: true, clientDecidedBy: true } }),
    ]);
    let taskRows: { id: string; reference: string | null; title: string; dueDate: Date | null; completedAt: Date | null; statusId: string | null; milestoneId: string | null }[] = [];
    if (project.spaceId) {
      const listRows = await this.db.select({ id: lists.id }).from(lists).where(eq(lists.spaceId, project.spaceId));
      if (listRows.length) {
        taskRows = await this.db
          .select({ id: tasks.id, reference: tasks.reference, title: tasks.title, dueDate: tasks.dueDate, completedAt: tasks.completedAt, statusId: tasks.statusId, milestoneId: tasks.milestoneId })
          .from(tasks)
          .where(and(inArray(tasks.listId, listRows.map((l) => l.id)), eq(tasks.clientVisible, true), isNull(tasks.archivedAt)))
          .orderBy(asc(tasks.dueDate), asc(tasks.createdAt));
      }
    }
    const statusIds = [...new Set(taskRows.map((t) => t.statusId).filter((x): x is string => Boolean(x)))];
    const statusRows = statusIds.length ? await this.db.select({ id: statuses.id, name: statuses.name, category: statuses.category, color: statuses.color }).from(statuses).where(inArray(statuses.id, statusIds)) : [];
    const statusBy = new Map(statusRows.map((s) => [s.id, s]));
    const approverIds = [...new Set(msRows.map((m) => m.signoffApproverId).filter((x): x is string => Boolean(x)))];
    const approvers = approverIds.length ? await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, approverIds)) : [];
    const nameOf = new Map(approvers.map((u) => [u.id, u.name]));

    const done = stageRows.filter((s) => s.status === "completed").length;
    return {
      organization: { name: org?.name ?? "", brandColor: org?.brandColor ?? "#6366f1", brandLogoUrl: org?.brandLogoUrl ?? null, brandFooter: org?.brandFooter ?? null },
      project: {
        id: project.id,
        name: project.name,
        color: project.color,
        status: project.status,
        client: project.company?.name ?? project.clientName ?? null,
        lead: project.lead?.name ?? null,
        startDate: project.startDate?.toISOString() ?? null,
        endDate: project.endDate?.toISOString() ?? null,
        description: project.description,
      },
      stages: stageRows.map((s, i) => ({ id: s.id, index: i + 1, name: s.name, status: s.status, progressPct: s.progressPct, startedAt: s.startedAt?.toISOString() ?? null, completedAt: s.completedAt?.toISOString() ?? null })),
      stageSummary: { total: stageRows.length, completed: done, current: stageRows.find((s) => s.status === "active")?.name ?? stageRows.find((s) => s.status === "not_started")?.name ?? null },
      milestones: msRows.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        targetDate: m.targetDate?.toISOString() ?? null,
        reachedAt: m.reachedAt?.toISOString() ?? null,
        signoffStatus: m.signoffStatus,
        signoffNote: m.signoffNote,
        signoffBy: m.signoffApproverId ? nameOf.get(m.signoffApproverId) ?? null : null,
        openTasks: taskRows.filter((t) => t.milestoneId === m.id && !t.completedAt).length,
        clientDecision: (m.clientDecision as "approved" | "changes_requested" | null) ?? null,
        clientApprovedAt: m.clientDecidedAt?.toISOString() ?? null,
        clientApprovedBy: m.clientDecidedBy ?? null,
        clientApprovalNote: m.clientDecisionNote ?? null,
      })),
      tasks: taskRows.map((t) => {
        const st = t.statusId ? statusBy.get(t.statusId) : undefined;
        return { id: t.id, reference: t.reference, title: t.title, status: st?.name ?? null, statusCategory: st?.category ?? null, statusColor: st?.color ?? null, dueDate: t.dueDate?.toISOString() ?? null, completedAt: t.completedAt?.toISOString() ?? null };
      }),
      docs: docRows.map((d) => ({ id: d.id, title: d.title, icon: d.icon, updatedAt: d.updatedAt.toISOString(), reviewStatus: d.reviewStatus, shareToken: d.shareToken, clientDecision: (d.clientDecision as "approved" | "changes_requested" | null) ?? null, clientApprovedAt: d.clientDecidedAt?.toISOString() ?? null, clientApprovedBy: d.clientDecidedBy ?? null })),
      generatedAt: new Date().toISOString(),
    };
  }

  /** One client-visible doc, internal blocks already stripped. */
  async doc(orgId: string, projectId: string, docId: string) {
    const row = await this.db.query.documents.findFirst({ where: and(eq(documents.id, docId), eq(documents.organizationId, orgId), eq(documents.projectId, projectId), eq(documents.clientVisible, true), isNull(documents.archivedAt)) });
    if (!row) throw new NotFoundException("Document not found");
    const content = await this.documents.exportContent(orgId, row.content);
    return { id: row.id, title: row.title, icon: row.icon, settings: row.settings, content, body: content ? textOf(content) : row.body, updatedAt: row.updatedAt.toISOString(), reviewStatus: row.reviewStatus };
  }
}
