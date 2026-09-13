import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { lists, milestones, projectStages, projects, statuses, tags, taskTags, taskTemplates, tasks } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export interface TemplateSubtask {
  title: string;
  dueOffsetDays: number | null;
}
export interface TemplateTask {
  title: string;
  description: string | null;
  priority: "urgent" | "high" | "normal" | "low" | null;
  timeEstimateMinutes: number | null;
  /** Days after the project start date; null = no due date. */
  dueOffsetDays: number | null;
  stageName: string | null;
  milestoneName: string | null;
  tags: string[];
  subtasks: TemplateSubtask[];
}
export interface TemplateMilestone {
  name: string;
  offsetDays: number | null;
  clientVisible: boolean;
}

const DAY_MS = 86_400_000;
const dayDiff = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);
const addDays = (base: Date, days: number) => new Date(base.getTime() + days * DAY_MS);

/**
 * Task list templates (row 33): a snapshot of a list's tasks, subtasks and
 * the project's milestones, with dates stored as offsets from the project
 * start so applying one to a new project schedules everything relative to
 * that project's own start date.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  async list(orgId: string) {
    const rows = await this.db.query.taskTemplates.findMany({
      where: and(eq(taskTemplates.organizationId, orgId), isNull(taskTemplates.archivedAt)),
      orderBy: [asc(taskTemplates.name)],
    });
    return rows.map((t) => ({
      ...t,
      taskCount: t.items.length,
      subtaskCount: t.items.reduce((n, i) => n + i.subtasks.length, 0),
      milestoneCount: t.milestones.length,
    }));
  }

  /** Snapshot a list (and its project's milestones) as a reusable template. */
  async createFromList(orgId: string, userId: string, dto: { listId: string; name: string; description?: string }) {
    const list = await this.db.query.lists.findFirst({
      where: and(eq(lists.id, dto.listId), eq(lists.organizationId, orgId)),
    });
    if (!list) throw new NotFoundException("List not found");
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.spaceId, list.spaceId), eq(projects.organizationId, orgId)),
    });
    const rows = await this.db.query.tasks.findMany({
      where: and(eq(tasks.listId, list.id), isNull(tasks.parentTaskId), isNull(tasks.archivedAt)),
      with: {
        subtasks: { where: isNull(tasks.archivedAt), orderBy: [asc(tasks.position), asc(tasks.createdAt)] },
        stage: { columns: { name: true } },
        milestone: { columns: { name: true } },
        taskTags: { with: { tag: { columns: { name: true } } } },
      },
      orderBy: [asc(tasks.position), asc(tasks.createdAt)],
    });
    if (!rows.length) throw new BadRequestException("This list has no tasks to save as a template");

    // Offsets are relative to the project start when known, else the earliest due date in the list.
    const dueDates = [...rows, ...rows.flatMap((r) => r.subtasks)].map((t) => t.dueDate).filter((d): d is Date => Boolean(d));
    const base = project?.startDate ?? (dueDates.length ? new Date(Math.min(...dueDates.map((d) => d.getTime()))) : null);
    const offset = (d: Date | null) => (d && base ? dayDiff(base, d) : null);

    const items: TemplateTask[] = rows.map((t) => ({
      title: t.title,
      description: t.description ?? null,
      priority: t.priority ?? null,
      timeEstimateMinutes: t.timeEstimateMinutes ?? null,
      dueOffsetDays: offset(t.dueDate),
      stageName: t.stage?.name ?? null,
      milestoneName: t.milestone?.name ?? null,
      tags: t.taskTags.map((tt) => tt.tag.name),
      subtasks: t.subtasks.map((s) => ({ title: s.title, dueOffsetDays: offset(s.dueDate) })),
    }));
    const ms: TemplateMilestone[] = project
      ? (
          await this.db.query.milestones.findMany({
            where: and(eq(milestones.projectId, project.id), isNull(milestones.archivedAt)),
            orderBy: [asc(milestones.targetDate)],
          })
        ).map((m) => ({ name: m.name, offsetDays: offset(m.targetDate), clientVisible: m.clientVisible }))
      : [];

    const [row] = await this.db
      .insert(taskTemplates)
      .values({ organizationId: orgId, name: dto.name.trim(), description: dto.description ?? null, items, milestones: ms, createdById: userId })
      .returning();
    return row!;
  }

  async update(orgId: string, id: string, dto: { name?: string; description?: string | null }) {
    const [row] = await this.db
      .update(taskTemplates)
      .set({ ...(dto.name !== undefined ? { name: dto.name.trim() } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}), updatedAt: new Date() })
      .where(and(eq(taskTemplates.id, id), eq(taskTemplates.organizationId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Template not found");
    return row;
  }

  async remove(orgId: string, id: string) {
    const [row] = await this.db
      .update(taskTemplates)
      .set({ archivedAt: new Date() })
      .where(and(eq(taskTemplates.id, id), eq(taskTemplates.organizationId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Template not found");
    return { id, deleted: true };
  }

  /**
   * Create the template's milestones and tasks in a project. Dates come from
   * the project's start date (today when unset). Stages and milestones are
   * matched by name; tags are created in the workspace when missing.
   */
  async apply(orgId: string, userId: string, id: string, dto: { projectId: string; listId?: string }) {
    const template = await this.db.query.taskTemplates.findFirst({
      where: and(eq(taskTemplates.id, id), eq(taskTemplates.organizationId, orgId), isNull(taskTemplates.archivedAt)),
    });
    if (!template) throw new NotFoundException("Template not found");
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, dto.projectId), eq(projects.organizationId, orgId)),
    });
    if (!project) throw new NotFoundException("Project not found");
    if (!project.spaceId) throw new BadRequestException("This project has no space to add tasks to");

    const list = dto.listId
      ? await this.db.query.lists.findFirst({ where: and(eq(lists.id, dto.listId), eq(lists.spaceId, project.spaceId)) })
      : await this.db.query.lists.findFirst({ where: eq(lists.spaceId, project.spaceId), orderBy: [asc(lists.position)] });
    if (!list) throw new BadRequestException("Pick a list in this project to add the tasks to");

    const base = project.startDate ?? new Date();
    const firstStatus = await this.db.query.statuses.findFirst({
      where: and(eq(statuses.spaceId, project.spaceId), eq(statuses.organizationId, orgId)),
      orderBy: [asc(statuses.position)],
    });
    const stageRows = await this.db.query.projectStages.findMany({ where: eq(projectStages.projectId, project.id) });
    const stageByName = new Map(stageRows.map((s) => [s.name.toLowerCase(), s.id]));

    // Milestones: reuse one with the same name, otherwise create it.
    const existingMs = await this.db.query.milestones.findMany({
      where: and(eq(milestones.projectId, project.id), isNull(milestones.archivedAt)),
    });
    const msByName = new Map(existingMs.map((m) => [m.name.toLowerCase(), m.id]));
    let milestonesCreated = 0;
    for (const m of template.milestones) {
      if (msByName.has(m.name.toLowerCase())) continue;
      const [row] = await this.db
        .insert(milestones)
        .values({
          organizationId: orgId,
          projectId: project.id,
          name: m.name,
          targetDate: m.offsetDays === null ? null : addDays(base, m.offsetDays),
          clientVisible: m.clientVisible,
          createdById: userId,
        })
        .returning();
      msByName.set(m.name.toLowerCase(), row!.id);
      milestonesCreated++;
    }

    // Tags: workspace-wide, created on demand.
    const wanted = [...new Set(template.items.flatMap((i) => i.tags))];
    const tagIdByName = new Map<string, string>();
    if (wanted.length) {
      const existing = await this.db.query.tags.findMany({
        where: and(eq(tags.organizationId, orgId), isNull(tags.archivedAt)),
      });
      for (const t of existing) tagIdByName.set(t.name.toLowerCase(), t.id);
      for (const name of wanted) {
        if (tagIdByName.has(name.toLowerCase())) continue;
        const [row] = await this.db.insert(tags).values({ organizationId: orgId, spaceId: null, name, color: "#6b7280" }).onConflictDoNothing().returning();
        if (row) tagIdByName.set(name.toLowerCase(), row.id);
      }
    }

    let position = Date.now();
    let tasksCreated = 0;
    let subtasksCreated = 0;
    for (const item of template.items) {
      const [task] = await this.db
        .insert(tasks)
        .values({
          organizationId: orgId,
          listId: list.id,
          title: item.title,
          description: item.description,
          priority: item.priority ?? undefined,
          timeEstimateMinutes: item.timeEstimateMinutes,
          statusId: firstStatus?.id,
          dueDate: item.dueOffsetDays === null ? null : addDays(base, item.dueOffsetDays),
          stageId: item.stageName ? (stageByName.get(item.stageName.toLowerCase()) ?? null) : null,
          milestoneId: item.milestoneName ? (msByName.get(item.milestoneName.toLowerCase()) ?? null) : null,
          position: position++,
          createdById: userId,
        })
        .returning();
      tasksCreated++;
      const tagIds = item.tags.map((n) => tagIdByName.get(n.toLowerCase())).filter((x): x is string => Boolean(x));
      if (tagIds.length) await this.db.insert(taskTags).values(tagIds.map((tagId) => ({ taskId: task!.id, tagId }))).onConflictDoNothing();
      for (const sub of item.subtasks) {
        await this.db.insert(tasks).values({
          organizationId: orgId,
          listId: list.id,
          parentTaskId: task!.id,
          title: sub.title,
          statusId: firstStatus?.id,
          dueDate: sub.dueOffsetDays === null ? null : addDays(base, sub.dueOffsetDays),
          position: position++,
          createdById: userId,
        });
        subtasksCreated++;
      }
      await this.activity.record({ orgId, actorId: userId, entityType: "task", entityId: task!.id, action: "created" });
    }
    return { listId: list.id, tasksCreated, subtasksCreated, milestonesCreated };
  }

  /** Ids of lists that belong to a project's space, for the apply picker. */
  async listsForProject(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { spaceId: true },
    });
    if (!project?.spaceId) return [];
    const rows = await this.db.query.lists.findMany({ where: eq(lists.spaceId, project.spaceId), orderBy: [asc(lists.position)] });
    return rows.map((l) => ({ id: l.id, name: l.name }));
  }

  /** Used by the seed and tests: templates referenced by id in one query. */
  async byIds(orgId: string, ids: string[]) {
    if (!ids.length) return [];
    return this.db.query.taskTemplates.findMany({ where: and(eq(taskTemplates.organizationId, orgId), inArray(taskTemplates.id, ids)) });
  }
}
