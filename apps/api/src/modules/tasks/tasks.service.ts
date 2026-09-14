import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  companies,
  contacts,
  cycleTasks,
  deals,
  lists,
  messages,
  milestones,
  projectStages,
  statuses,
  tags,
  taskAssignees,
  taskRelations,
  taskTags,
  tasks,
} from "../../db/schema.js";
import type { BulkUpdateDto, CreateTaskDto, UpdateTaskDto } from "./tasks.dto.js";
import { ActivityService, type FieldChange } from "../activity/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { ProjectsService } from "../projects/projects.service.js";

/** Fields worth recording a diff for. Anything else changes silently. */
const TRACKED_FIELDS = [
  "title",
  "description",
  "statusId",
  "priority",
  "dueDate",
  "startDate",
  "listId",
  "stageId",
  "milestoneId",
  "companyId",
  "contactId",
  "dealId",
  "timeEstimateMinutes",
];

/** Relation shape for the CRM links a task carries (row 38). */
const CRM_WITH = {
  company: { columns: { id: true, name: true } },
  contact: { columns: { id: true, firstName: true, lastName: true } },
  deal: { columns: { id: true, title: true, stage: true } },
} as const;

/** Given relation A→B, the row we mirror onto B so both tasks show the link. */
const INVERSE_RELATION = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  duplicates: "duplicates",
  relates_to: "relates_to",
} as const;

type RelationKind = keyof typeof INVERSE_RELATION;

@Injectable()
export class TasksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * List top-level tasks in a list. Note the `organizationId` filter on EVERY
   * query — this is the tenant boundary. A missing org filter is a data leak,
   * so it is never optional.
   */
  async listByList(orgId: string, listId: string) {
    const rows = await this.db.query.tasks.findMany({
      where: and(
        eq(tasks.organizationId, orgId),
        eq(tasks.listId, listId),
        isNull(tasks.parentTaskId),
        isNull(tasks.archivedAt),
      ),
      with: {
        status: true,
        stage: { columns: { id: true, name: true, status: true } },
        milestone: { columns: { id: true, name: true, targetDate: true, reachedAt: true } },
        ...CRM_WITH,
        assignees: { with: { user: true } },
        subtasks: true,
      },
      orderBy: (t, { asc }) => [asc(t.position)],
    });
    const tagMap = await this.tagsFor(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));
  }

  async findOne(orgId: string, id: string) {
    const task = await this.db.query.tasks.findFirst({
      where: and(eq(tasks.id, id), eq(tasks.organizationId, orgId)),
      with: {
        status: true,
        stage: { columns: { id: true, name: true, status: true } },
        milestone: { columns: { id: true, name: true, targetDate: true, reachedAt: true } },
        ...CRM_WITH,
        sourceMessage: { columns: { id: true, channelId: true, body: true, createdAt: true }, with: { author: { columns: { id: true, name: true } }, channel: { columns: { id: true, name: true, type: true } } } },
        assignees: { with: { user: true } },
        subtasks: {
          with: { status: true, assignees: { with: { user: true } } },
          orderBy: (t, { asc }) => [asc(t.position), asc(t.createdAt)],
        },
        comments: { with: { author: true } },
      },
    });
    if (!task) throw new NotFoundException("Task not found");

    const [tagMap, cycle] = await Promise.all([
      this.tagsFor([task.id]),
      this.db.query.cycleTasks.findFirst({ where: eq(cycleTasks.taskId, task.id) }),
    ]);
    return { ...task, tags: tagMap.get(task.id) ?? [], cycleId: cycle?.cycleId ?? null };
  }

  /** Tags for many tasks in one query, keyed by task id. */
  private async tagsFor(taskIds: string[]) {
    const out = new Map<string, { id: string; name: string; color: string }[]>();
    if (!taskIds.length) return out;
    const rows = await this.db
      .select({ taskId: taskTags.taskId, id: tags.id, name: tags.name, color: tags.color })
      .from(taskTags)
      .innerJoin(tags, eq(tags.id, taskTags.tagId))
      .where(inArray(taskTags.taskId, taskIds));
    for (const r of rows) {
      (out.get(r.taskId) ?? out.set(r.taskId, []).get(r.taskId)!).push({ id: r.id, name: r.name, color: r.color });
    }
    return out;
  }

  /** Tag must belong to the task's space — labels don't leak across spaces. */
  async addTag(orgId: string, actorId: string, taskId: string, tagId: string) {
    await this.findOne(orgId, taskId);
    const tag = await this.db.query.tags.findFirst({
      where: and(eq(tags.id, tagId), eq(tags.organizationId, orgId), isNull(tags.archivedAt)),
    });
    if (!tag) throw new BadRequestException("Tag not found in this workspace");
    await this.db.insert(taskTags).values({ taskId, tagId }).onConflictDoNothing();
    await this.activity.record({
      orgId,
      actorId,
      entityType: "task",
      entityId: taskId,
      action: "tagged",
      changes: [{ field: "tag", from: null, to: tag.name }],
    });
    return this.findOne(orgId, taskId);
  }

  async removeTag(orgId: string, actorId: string, taskId: string, tagId: string) {
    await this.findOne(orgId, taskId);
    await this.db.delete(taskTags).where(and(eq(taskTags.taskId, taskId), eq(taskTags.tagId, tagId)));
    await this.activity.record({
      orgId,
      actorId,
      entityType: "task",
      entityId: taskId,
      action: "untagged",
      changes: [{ field: "tag", from: tagId, to: null }],
    });
    return this.findOne(orgId, taskId);
  }

  /** A stage may only be used by tasks in the project that owns the list's space. */
  private async assertStageForList(orgId: string, listId: string, stageId: string) {
    const list = await this.db.query.lists.findFirst({ where: and(eq(lists.id, listId), eq(lists.organizationId, orgId)) });
    const stage = await this.db.query.projectStages.findFirst({
      where: and(eq(projectStages.id, stageId), eq(projectStages.organizationId, orgId)),
      with: { project: { columns: { spaceId: true } } },
    });
    if (!list || !stage || stage.project.spaceId !== list.spaceId) {
      throw new BadRequestException("That stage belongs to a different project");
    }
  }

  /** Milestones follow the same rule as stages: same project as the task's space. */
  private async assertMilestoneForList(orgId: string, listId: string, milestoneId: string) {
    const list = await this.db.query.lists.findFirst({ where: and(eq(lists.id, listId), eq(lists.organizationId, orgId)) });
    const milestone = await this.db.query.milestones.findFirst({
      where: and(eq(milestones.id, milestoneId), eq(milestones.organizationId, orgId), isNull(milestones.archivedAt)),
      with: { project: { columns: { spaceId: true } } },
    });
    if (!list || !milestone || milestone.project.spaceId !== list.spaceId) {
      throw new BadRequestException("That milestone belongs to a different project");
    }
  }

  /**
   * Row 38: CRM links must belong to this org. Picking a deal fills in its
   * company and contact unless the caller set them explicitly, so a follow-up
   * on a deal also shows on the client's page.
   */
  private async assertCrmLinks(orgId: string, dto: { companyId?: string | null; contactId?: string | null; dealId?: string | null }) {
    const out: { companyId?: string | null; contactId?: string | null; dealId?: string | null } = {};
    if (dto.dealId !== undefined) out.dealId = dto.dealId;
    if (dto.companyId !== undefined) out.companyId = dto.companyId;
    if (dto.contactId !== undefined) out.contactId = dto.contactId;
    if (dto.dealId) {
      const deal = await this.db.query.deals.findFirst({
        where: and(eq(deals.id, dto.dealId), eq(deals.organizationId, orgId)),
        columns: { id: true, companyId: true, contactId: true },
      });
      if (!deal) throw new BadRequestException("Unknown deal");
      if (dto.companyId === undefined && deal.companyId) out.companyId = deal.companyId;
      if (dto.contactId === undefined && deal.contactId) out.contactId = deal.contactId;
    }
    if (out.companyId) {
      const c = await this.db.query.companies.findFirst({ where: and(eq(companies.id, out.companyId), eq(companies.organizationId, orgId)), columns: { id: true } });
      if (!c) throw new BadRequestException("Unknown company");
    }
    if (out.contactId) {
      const c = await this.db.query.contacts.findFirst({ where: and(eq(contacts.id, out.contactId), eq(contacts.organizationId, orgId)), columns: { id: true, companyId: true } });
      if (!c) throw new BadRequestException("Unknown contact");
      // A contact implies their company when none was chosen.
      if (out.companyId === undefined && c.companyId) out.companyId = c.companyId;
    }
    return out;
  }

  /**
   * Tasks attached to a company, contact or deal — the "follow-ups" list on a
   * client's page. Open tasks first, then done ones; each row carries its
   * list/space so the page can say where the work lives.
   */
  async forCrm(orgId: string, link: { companyId?: string; contactId?: string; dealId?: string }) {
    const filters = [
      link.companyId ? eq(tasks.companyId, link.companyId) : null,
      link.contactId ? eq(tasks.contactId, link.contactId) : null,
      link.dealId ? eq(tasks.dealId, link.dealId) : null,
    ].filter((f): f is NonNullable<typeof f> => Boolean(f));
    if (!filters.length) throw new BadRequestException("companyId, contactId or dealId is required");
    const rows = await this.db.query.tasks.findMany({
      where: and(eq(tasks.organizationId, orgId), isNull(tasks.archivedAt), or(...filters)),
      with: {
        status: true,
        ...CRM_WITH,
        assignees: { with: { user: true } },
        list: { columns: { id: true, name: true, spaceId: true }, with: { space: { columns: { id: true, name: true } } } },
      },
      orderBy: (t, { asc }) => [asc(t.dueDate), asc(t.createdAt)],
    });
    const rank = (t: (typeof rows)[number]) => (t.status?.category === "done" ? 1 : 0);
    return rows
      .sort((a, b) => rank(a) - rank(b))
      .map((t) => ({
        ...t,
        subtasks: [],
        list: t.list ? { id: t.list.id, name: t.list.name, spaceId: t.list.spaceId, spaceName: t.list.space?.name ?? null } : null,
      }));
  }

  async create(orgId: string, userId: string, dto: CreateTaskDto) {
    if (dto.stageId) await this.assertStageForList(orgId, dto.listId, dto.stageId);
    if (dto.milestoneId) await this.assertMilestoneForList(orgId, dto.listId, dto.milestoneId);
    const crm = await this.assertCrmLinks(orgId, dto);
    // Row 47: the message must be one of ours; the link is informational only.
    if (dto.sourceMessageId) {
      const msg = await this.db.query.messages.findFirst({ where: and(eq(messages.id, dto.sourceMessageId), eq(messages.organizationId, orgId)), columns: { id: true } });
      if (!msg) throw new BadRequestException("Unknown chat message");
    }
    let statusId = dto.statusId;
    if (dto.parentTaskId) {
      // Subtasks are one level deep: a subtask cannot have its own subtasks.
      const parent = await this.db.query.tasks.findFirst({
        where: and(eq(tasks.id, dto.parentTaskId), eq(tasks.organizationId, orgId)),
        columns: { id: true, parentTaskId: true, listId: true, statusId: true },
      });
      if (!parent) throw new NotFoundException("Parent task not found");
      if (parent.parentTaskId) throw new BadRequestException("Subtasks can only go one level deep");
      // A subtask starts in the space's first status so it shows up in every view.
      if (!statusId) {
        const list = await this.db.query.lists.findFirst({ where: eq(lists.id, parent.listId), columns: { spaceId: true } });
        const first = list
          ? await this.db.query.statuses.findFirst({
              where: and(eq(statuses.spaceId, list.spaceId), eq(statuses.organizationId, orgId)),
              orderBy: (st, { asc }) => [asc(st.position)],
            })
          : null;
        statusId = first?.id;
      }
    }
    const [task] = await this.db
      .insert(tasks)
      .values({
        organizationId: orgId,
        listId: dto.listId,
        title: dto.title,
        description: dto.description,
        statusId,
        priority: dto.priority ?? undefined,
        parentTaskId: dto.parentTaskId,
        stageId: dto.stageId ?? undefined,
        milestoneId: dto.milestoneId ?? undefined,
        recurrence: dto.recurrence ?? undefined,
        recurrenceInterval: dto.recurrenceInterval ?? undefined,
        companyId: crm.companyId ?? undefined,
        contactId: crm.contactId ?? undefined,
        dealId: crm.dealId ?? undefined,
        sourceMessageId: dto.sourceMessageId ?? undefined,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        timeEstimateMinutes: dto.timeEstimateMinutes ?? undefined,
        createdById: userId,
      })
      .returning();

    if (dto.assigneeIds?.length && task) {
      await this.db.insert(taskAssignees).values(
        dto.assigneeIds.map((assigneeId) => ({
          taskId: task.id,
          userId: assigneeId,
          organizationId: orgId,
        })),
      );
    }

    // Assignees join the project team (and its channel) — row 39.
    if (dto.assigneeIds?.length) await this.projects.ensureMembersForList(orgId, dto.listId, dto.assigneeIds);

    // The creator follows what they made; assignees follow what they're given.
    await this.notifications.subscribe(orgId, task!.id, userId);
    for (const assigneeId of dto.assigneeIds ?? []) {
      await this.notifications.subscribe(orgId, task!.id, assigneeId);
    }

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "task",
      entityId: task!.id,
      action: "created",
    });

    if (dto.assigneeIds?.length) {
      await this.notifications.notifyTaskEvent({
        orgId,
        taskId: task!.id,
        actorId: userId,
        verb: "assigned",
        title: task!.title,
        body: "assigned you a new task",
      });
    }

    return task;
  }

  async update(orgId: string, userId: string, id: string, dto: UpdateTaskDto) {
    const before = await this.db.query.tasks.findFirst({
      where: and(eq(tasks.id, id), eq(tasks.organizationId, orgId)),
    });
    if (!before) throw new NotFoundException("Task not found");
    if (dto.stageId) await this.assertStageForList(orgId, before.listId, dto.stageId);
    if (dto.milestoneId) await this.assertMilestoneForList(orgId, before.listId, dto.milestoneId);
    const crm = await this.assertCrmLinks(orgId, dto);

    // `assigneeIds` is not a column; it is synced separately below. The source
    // message is set once at creation and never rewritten.
    const { assigneeIds, sourceMessageId: _source, ...rest } = dto;
    const fields = { ...rest, ...crm };
    const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v ? new Date(v) : null);
    const patch: Record<string, unknown> = {
      ...fields,
      startDate: toDate(dto.startDate),
      dueDate: toDate(dto.dueDate),
      updatedAt: new Date(),
    };

    // Moving into a "done" status stamps completedAt; moving back out clears it.
    let completed = false;
    if (dto.statusId && dto.statusId !== before.statusId) {
      const status = await this.db.query.statuses.findFirst({
        where: and(eq(statuses.id, dto.statusId), eq(statuses.organizationId, orgId)),
      });
      if (!status) throw new BadRequestException("Unknown status for this organization");
      completed = status.category === "done";
      patch.completedAt = completed ? new Date() : null;
    }

    const [task] = await this.db
      .update(tasks)
      .set(patch)
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, orgId)))
      .returning();

    if (assigneeIds) await this.syncAssignees(orgId, userId, id, assigneeIds);
    // Recurring task ticked off: the next instance appears right away.
    if (completed && task?.recurrence && !task.parentTaskId) await this.spawnNextOccurrence(orgId, userId, task);

    const changes = this.activity.diff(
      before as unknown as Record<string, unknown>,
      fields as unknown as Record<string, unknown>,
      TRACKED_FIELDS,
    );

    if (changes.length) {
      // Editing a task means you care about it: follow it, so you hear about
      // the reply. Without this, whoever edits is the one person left out.
      await this.notifications.subscribe(orgId, id, userId);

      const verb = completed
        ? "completed"
        : changes.some((c) => c.field === "statusId")
          ? "status_changed"
          : "updated";

      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "task",
        entityId: id,
        action: verb,
        changes,
      });

      await this.notifications.notifyTaskEvent({
        orgId,
        taskId: id,
        actorId: userId,
        verb,
        title: task!.title,
        body: describeChanges(changes),
        changes,
      });
    }

    return task;
  }


  /**
   * Row 36: when a repeating task is completed, create its next instance —
   * same title, description, priority, estimate, assignees, tags, stage,
   * milestone and rule — with the due date advanced by the rule from the
   * current due date (or today when it had none).
   */
  private async spawnNextOccurrence(
    orgId: string,
    userId: string,
    done: { id: string; listId: string; title: string; description: string | null; priority: "urgent" | "high" | "normal" | "low" | null; timeEstimateMinutes: number | null; dueDate: Date | null; startDate: Date | null; stageId: string | null; milestoneId: string | null; recurrence: "daily" | "weekly" | "monthly" | null; recurrenceInterval: number; companyId: string | null; contactId: string | null; dealId: string | null },
  ) {
    const advance = (d: Date) => {
      const next = new Date(d);
      const n = Math.max(1, done.recurrenceInterval || 1);
      if (done.recurrence === "daily") next.setUTCDate(next.getUTCDate() + n);
      else if (done.recurrence === "weekly") next.setUTCDate(next.getUTCDate() + 7 * n);
      else next.setUTCMonth(next.getUTCMonth() + n);
      return next;
    };
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    let nextDue = advance(done.dueDate ?? today);
    // If the task was overdue, keep advancing so the next one lands in the future.
    while (nextDue < today) nextDue = advance(nextDue);
    const nextStart = done.startDate && done.dueDate ? new Date(nextDue.getTime() - (done.dueDate.getTime() - done.startDate.getTime())) : null;

    const list = await this.db.query.lists.findFirst({ where: eq(lists.id, done.listId), columns: { spaceId: true } });
    const first = list
      ? await this.db.query.statuses.findFirst({
          where: and(eq(statuses.spaceId, list.spaceId), eq(statuses.organizationId, orgId)),
          orderBy: (st, { asc }) => [asc(st.position)],
        })
      : null;
    const [assigneeRows, tagRows] = await Promise.all([
      this.db.query.taskAssignees.findMany({ where: eq(taskAssignees.taskId, done.id) }),
      this.db.select({ tagId: taskTags.tagId }).from(taskTags).where(eq(taskTags.taskId, done.id)),
    ]);

    const [next] = await this.db
      .insert(tasks)
      .values({
        organizationId: orgId,
        listId: done.listId,
        title: done.title,
        description: done.description,
        priority: done.priority ?? undefined,
        timeEstimateMinutes: done.timeEstimateMinutes,
        statusId: first?.id,
        dueDate: nextDue,
        startDate: nextStart,
        stageId: done.stageId,
        milestoneId: done.milestoneId,
        recurrence: done.recurrence,
        recurrenceInterval: done.recurrenceInterval,
        recurredFromId: done.id,
        companyId: done.companyId,
        contactId: done.contactId,
        dealId: done.dealId,
        position: Date.now(),
        createdById: userId,
      })
      .returning();
    if (assigneeRows.length) {
      await this.db.insert(taskAssignees).values(assigneeRows.map((a) => ({ taskId: next!.id, userId: a.userId, organizationId: orgId })));
      for (const a of assigneeRows) await this.notifications.subscribe(orgId, next!.id, a.userId);
    }
    if (tagRows.length) await this.db.insert(taskTags).values(tagRows.map((t) => ({ taskId: next!.id, tagId: t.tagId }))).onConflictDoNothing();
    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "task",
      entityId: next!.id,
      action: "recurred",
      changes: [{ field: "recurredFromId", from: null, to: done.id }],
    });
    return next!;
  }

  /**
   * Apply one change set to many tasks. Each task goes through `update` so
   * status/completion rules, activity and notifications behave exactly as a
   * single edit would. Moving to a list in another space re-maps the status
   * to that space's first status and drops stage/milestone (they are
   * project-specific).
   */
  async bulkUpdate(orgId: string, userId: string, dto: BulkUpdateDto) {
    const { addTagIds = [], removeTagIds = [], listId, ...patch } = dto.patch;
    let targetList: { id: string; spaceId: string } | null = null;
    let targetStatusId: string | undefined;
    if (listId) {
      const list = await this.db.query.lists.findFirst({
        where: and(eq(lists.id, listId), eq(lists.organizationId, orgId)),
        columns: { id: true, spaceId: true },
      });
      if (!list) throw new NotFoundException("Target list not found");
      targetList = list;
      const first = await this.db.query.statuses.findFirst({
        where: and(eq(statuses.spaceId, list.spaceId), eq(statuses.organizationId, orgId)),
        orderBy: (st, { asc }) => [asc(st.position)],
      });
      targetStatusId = first?.id;
    }

    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of dto.ids) {
      try {
        const before = await this.db.query.tasks.findFirst({
          where: and(eq(tasks.id, id), eq(tasks.organizationId, orgId)),
          with: { list: { columns: { spaceId: true } } },
        });
        if (!before) throw new NotFoundException("Task not found");

        if (targetList && targetList.id !== before.listId) {
          const crossSpace = targetList.spaceId !== before.list.spaceId;
          await this.db
            .update(tasks)
            .set({
              listId: targetList.id,
              ...(crossSpace ? { statusId: targetStatusId ?? null, stageId: null, milestoneId: null } : {}),
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, id));
          // Subtasks travel with their parent.
          await this.db
            .update(tasks)
            .set({ listId: targetList.id, ...(crossSpace ? { statusId: targetStatusId ?? null, stageId: null, milestoneId: null } : {}) })
            .where(eq(tasks.parentTaskId, id));
          await this.activity.record({
            orgId,
            actorId: userId,
            entityType: "task",
            entityId: id,
            action: "moved",
            changes: [{ field: "listId", from: before.listId, to: targetList.id }],
          });
        }

        const hasPatch = Object.values(patch).some((v) => v !== undefined);
        if (hasPatch) await this.update(orgId, userId, id, patch);
        for (const tagId of addTagIds) await this.addTag(orgId, userId, id, tagId);
        for (const tagId of removeTagIds) await this.removeTag(orgId, userId, id, tagId);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results };
  }

  /** Replace the assignee set (used by PATCH and bulk edits); records add/remove activity per user. */
  async syncAssignees(orgId: string, actorId: string, taskId: string, userIds: string[]) {
    const current = await this.db.query.taskAssignees.findMany({
      where: and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.organizationId, orgId)),
    });
    const have = new Set(current.map((a) => a.userId));
    const want = new Set(userIds);
    for (const userId of want) if (!have.has(userId)) await this.addAssignee(orgId, actorId, taskId, userId);
    for (const userId of have) if (!want.has(userId)) await this.removeAssignee(orgId, actorId, taskId, userId);
  }

  async addAssignee(orgId: string, actorId: string, taskId: string, userId: string) {
    const task = await this.findOne(orgId, taskId);
    await this.db
      .insert(taskAssignees)
      .values({ taskId, userId, organizationId: orgId })
      .onConflictDoNothing();
    // Row 39: being assigned work in a project makes you part of the project team.
    await this.projects.ensureMembersForList(orgId, task.listId, [userId]);

    await this.notifications.subscribe(orgId, taskId, userId);
    await this.activity.record({
      orgId,
      actorId,
      entityType: "task",
      entityId: taskId,
      action: "assigned",
      changes: [{ field: "assignee", from: null, to: userId }],
    });
    await this.notifications.notifyTaskEvent({
      orgId,
      taskId,
      actorId,
      verb: "assigned",
      title: task.title,
      body: "assigned this task",
    });

    return this.findOne(orgId, taskId);
  }

  async removeAssignee(orgId: string, actorId: string, taskId: string, userId: string) {
    await this.findOne(orgId, taskId);
    await this.db
      .delete(taskAssignees)
      .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.userId, userId)));

    await this.activity.record({
      orgId,
      actorId,
      entityType: "task",
      entityId: taskId,
      action: "unassigned",
      changes: [{ field: "assignee", from: userId, to: null }],
    });

    return this.findOne(orgId, taskId);
  }

  async remove(orgId: string, actorId: string, id: string) {
    const [task] = await this.db
      .update(tasks)
      .set({ archivedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, orgId)))
      .returning();
    if (!task) throw new NotFoundException("Task not found");

    await this.activity.record({
      orgId,
      actorId,
      entityType: "task",
      entityId: id,
      action: "archived",
    });
    return { id: task.id, archived: true };
  }

  /* ---------------------------------------------------------------- *
   * Activity & comments
   * ---------------------------------------------------------------- */

  async activityFor(orgId: string, taskId: string) {
    await this.findOne(orgId, taskId);
    return this.activity.listFor(orgId, "task", taskId);
  }

  /**
   * "My Tasks": everything assigned to me across the whole org, open, soonest
   * due first (Postgres sorts nulls last on ASC, so undated tasks trail). The
   * list name is fetched in one extra query rather than a join per row.
   */
  async mine(orgId: string, userId: string, includeDone = false) {
    const assigned = await this.db
      .select({ taskId: taskAssignees.taskId })
      .from(taskAssignees)
      .where(
        and(eq(taskAssignees.organizationId, orgId), eq(taskAssignees.userId, userId)),
      );
    if (!assigned.length) return [];

    const rows = await this.db.query.tasks.findMany({
      where: and(
        eq(tasks.organizationId, orgId),
        inArray(
          tasks.id,
          assigned.map((a) => a.taskId),
        ),
        isNull(tasks.archivedAt),
      ),
      with: {
        status: true,
        stage: { columns: { id: true, name: true, status: true } },
        assignees: { with: { user: true } },
      },
      orderBy: (t, { asc }) => [asc(t.dueDate), asc(t.createdAt)],
    });

    const open = includeDone ? rows : rows.filter((t) => t.status?.category !== "done");
    const listIds = [...new Set(open.map((r) => r.listId))];
    const listRows = listIds.length
      ? await this.db.query.lists.findMany({
          where: inArray(lists.id, listIds),
          with: { space: { columns: { id: true, name: true } } },
        })
      : [];
    const listById = new Map(listRows.map((l) => [l.id, l]));

    return open.map((t) => {
      const list = listById.get(t.listId);
      return {
        ...t,
        list: list ? { id: t.listId, name: list.name, spaceId: list.spaceId, spaceName: list.space?.name ?? null } : null,
      };
    });
  }

  /** Move a task into the first "done" status of its space (My Work check-off). */
  async complete(orgId: string, userId: string, id: string) {
    const target = await this.statusOfCategory(orgId, id, ["done"]);
    return this.update(orgId, userId, id, { statusId: target });
  }

  /** Move a task back to the first not-started (or active) status of its space. */
  async reopen(orgId: string, userId: string, id: string) {
    const target = await this.statusOfCategory(orgId, id, ["not_started", "active"]);
    return this.update(orgId, userId, id, { statusId: target });
  }

  private async statusOfCategory(orgId: string, taskId: string, categories: ("not_started" | "active" | "done" | "closed")[]) {
    const task = await this.db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)),
      with: { list: { columns: { spaceId: true } } },
    });
    if (!task) throw new NotFoundException("Task not found");
    const all = await this.db.query.statuses.findMany({
      where: and(eq(statuses.spaceId, task.list.spaceId), eq(statuses.organizationId, orgId)),
      orderBy: (s, { asc }) => [asc(s.position)],
    });
    for (const c of categories) {
      const hit = all.find((s) => s.category === c);
      if (hit) return hit.id;
    }
    throw new BadRequestException(`This space has no "${categories[0]}" status — add one in Settings`);
  }

  /* ---------------------------------------------------------------- *
   * Relations
   * ---------------------------------------------------------------- */

  /** Both directions of every link that touches this task. */
  async relationsFor(orgId: string, taskId: string) {
    await this.findOne(orgId, taskId);
    const rows = await this.db
      .select()
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.organizationId, orgId),
          eq(taskRelations.taskId, taskId),
        ),
      );

    if (!rows.length) return [];

    const related = await this.db.query.tasks.findMany({
      where: inArray(
        tasks.id,
        rows.map((r) => r.relatedTaskId),
      ),
      with: { status: true },
    });
    const byId = new Map(related.map((t) => [t.id, t]));

    return rows.map((r) => ({
      id: r.id,
      relation: r.relation,
      task: byId.get(r.relatedTaskId) ?? null,
    }));
  }

  /**
   * Links two tasks and writes the mirrored row, so opening either one shows the
   * relationship. Self-links and cross-org links are rejected outright.
   */
  async addRelation(
    orgId: string,
    actorId: string,
    taskId: string,
    relatedTaskId: string,
    relation: RelationKind,
  ) {
    if (taskId === relatedTaskId) {
      throw new BadRequestException("A task cannot relate to itself");
    }
    await this.findOne(orgId, taskId);
    await this.findOne(orgId, relatedTaskId); // also proves same-org

    await this.db
      .insert(taskRelations)
      .values([
        { organizationId: orgId, taskId, relatedTaskId, relation, createdById: actorId },
        {
          organizationId: orgId,
          taskId: relatedTaskId,
          relatedTaskId: taskId,
          relation: INVERSE_RELATION[relation],
          createdById: actorId,
        },
      ])
      .onConflictDoNothing();

    await this.activity.record({
      orgId,
      actorId,
      entityType: "task",
      entityId: taskId,
      action: "linked",
      changes: [{ field: relation, from: null, to: relatedTaskId }],
    });

    return this.relationsFor(orgId, taskId);
  }

  /** Removes both directions — a one-sided link would be worse than none. */
  async removeRelation(orgId: string, actorId: string, taskId: string, relationId: string) {
    const row = await this.db.query.taskRelations.findFirst({
      where: and(
        eq(taskRelations.id, relationId),
        eq(taskRelations.organizationId, orgId),
      ),
    });
    if (!row) throw new NotFoundException("Relation not found");

    await this.db
      .delete(taskRelations)
      .where(
        and(
          eq(taskRelations.organizationId, orgId),
          or(
            and(
              eq(taskRelations.taskId, row.taskId),
              eq(taskRelations.relatedTaskId, row.relatedTaskId),
            ),
            and(
              eq(taskRelations.taskId, row.relatedTaskId),
              eq(taskRelations.relatedTaskId, row.taskId),
            ),
          ),
        ),
      );

    await this.activity.record({
      orgId,
      actorId,
      entityType: "task",
      entityId: taskId,
      action: "unlinked",
      changes: [{ field: row.relation, from: row.relatedTaskId, to: null }],
    });

    return this.relationsFor(orgId, taskId);
  }
}

/** Short human summary stored on the notification, e.g. "changed status, priority". */
function describeChanges(changes: FieldChange[]) {
  const names: Record<string, string> = {
    statusId: "status",
    dueDate: "due date",
    startDate: "start date",
    timeEstimateMinutes: "estimate",
    listId: "list",
    stageId: "stage",
    milestoneId: "milestone",
    companyId: "company",
    contactId: "contact",
    dealId: "deal",
    priority: "priority",
    title: "title",
    description: "description",
  };
  return `changed ${changes.map((c) => names[c.field] ?? c.field).join(", ")}`;
}
