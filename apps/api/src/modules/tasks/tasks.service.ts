import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  cycleTasks,
  lists,
  projectStages,
  statuses,
  tags,
  taskAssignees,
  taskRelations,
  taskTags,
  tasks,
} from "../../db/schema.js";
import type { CreateTaskDto, UpdateTaskDto } from "./tasks.dto.js";
import { ActivityService, type FieldChange } from "../activity/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";

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
  "timeEstimateMinutes",
];

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

  async create(orgId: string, userId: string, dto: CreateTaskDto) {
    if (dto.stageId) await this.assertStageForList(orgId, dto.listId, dto.stageId);
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

    // `assigneeIds` is not a column; it is synced separately below.
    const { assigneeIds, ...fields } = dto;
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
    timeEstimateMinutes: "estimate",
    listId: "list",
  };
  return `changed ${changes.map((c) => names[c.field] ?? c.field).join(", ")}`;
}
