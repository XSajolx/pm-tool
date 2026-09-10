import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  cycleTasks,
  lists,
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
        assignees: { with: { user: true } },
        subtasks: { with: { status: true } },
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
    const task = await this.findOne(orgId, taskId);
    const [list] = await this.db.select().from(lists).where(eq(lists.id, task.listId));
    const tag = await this.db.query.tags.findFirst({
      where: and(eq(tags.id, tagId), eq(tags.organizationId, orgId)),
    });
    if (!tag || !list || tag.spaceId !== list.spaceId) {
      throw new BadRequestException("Tag does not belong to this task's space");
    }
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

  async create(orgId: string, userId: string, dto: CreateTaskDto) {
    const [task] = await this.db
      .insert(tasks)
      .values({
        organizationId: orgId,
        listId: dto.listId,
        title: dto.title,
        description: dto.description,
        statusId: dto.statusId,
        priority: dto.priority,
        parentTaskId: dto.parentTaskId,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
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

    const patch: Record<string, unknown> = {
      ...dto,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
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

    const changes = this.activity.diff(
      before as unknown as Record<string, unknown>,
      dto as unknown as Record<string, unknown>,
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
  async mine(orgId: string, userId: string) {
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
      with: { status: true, assignees: { with: { user: true } } },
      orderBy: (t, { asc }) => [asc(t.dueDate), asc(t.createdAt)],
    });

    const listIds = [...new Set(rows.map((r) => r.listId))];
    const listRows = listIds.length
      ? await this.db.select().from(lists).where(inArray(lists.id, listIds))
      : [];
    const listById = new Map(listRows.map((l) => [l.id, l]));

    return rows.map((t) => ({
      ...t,
      list: listById.get(t.listId)
        ? { id: t.listId, name: listById.get(t.listId)!.name }
        : null,
    }));
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
