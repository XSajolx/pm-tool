import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { documents, lists, milestones, organizations, projectStages, projects, statuses, tasks, users } from "../../db/schema.js";
import { DocumentsService } from "../documents/documents.service.js";
import { textOf } from "../documents/doc-content.js";

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
  ) {}

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
      this.db.query.documents.findMany({ where: and(eq(documents.projectId, projectId), eq(documents.clientVisible, true), isNull(documents.archivedAt)), orderBy: [asc(documents.title)], columns: { id: true, title: true, icon: true, updatedAt: true, reviewStatus: true, shareToken: true } }),
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
      })),
      tasks: taskRows.map((t) => {
        const st = t.statusId ? statusBy.get(t.statusId) : undefined;
        return { id: t.id, reference: t.reference, title: t.title, status: st?.name ?? null, statusCategory: st?.category ?? null, statusColor: st?.color ?? null, dueDate: t.dueDate?.toISOString() ?? null, completedAt: t.completedAt?.toISOString() ?? null };
      }),
      docs: docRows.map((d) => ({ id: d.id, title: d.title, icon: d.icon, updatedAt: d.updatedAt.toISOString(), reviewStatus: d.reviewStatus, shareToken: d.shareToken })),
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
