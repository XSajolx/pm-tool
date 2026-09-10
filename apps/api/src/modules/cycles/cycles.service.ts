import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { cycleTasks, cycles, statuses, tasks } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export interface CreateCycleDto {
  spaceId: string;
  name: string;
  description?: string;
  startDate?: string;
  endDate?: string;
}

@Injectable()
export class CyclesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  /** Cycles for a space, each with a done/total progress count. */
  async listForSpace(orgId: string, spaceId: string) {
    const rows = await this.db
      .select()
      .from(cycles)
      .where(and(eq(cycles.organizationId, orgId), eq(cycles.spaceId, spaceId)))
      .orderBy(asc(cycles.startDate));

    if (!rows.length) return [];

    const progress = await this.progressFor(
      orgId,
      rows.map((c) => c.id),
    );

    return rows.map((c) => ({
      ...c,
      progress: progress[c.id] ?? { total: 0, done: 0 },
      state: cycleState(c.startDate, c.endDate),
    }));
  }

  /**
   * One grouped query for every cycle's counts rather than two per cycle.
   * "Done" is decided by the status *category*, so custom status names like
   * "Shipped" still count as complete.
   */
  private async progressFor(orgId: string, cycleIds: string[]) {
    const rows = await this.db
      .select({
        cycleId: cycleTasks.cycleId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${statuses.category} = 'done')::int`,
      })
      .from(cycleTasks)
      .innerJoin(tasks, eq(tasks.id, cycleTasks.taskId))
      .leftJoin(statuses, eq(statuses.id, tasks.statusId))
      .where(
        and(
          eq(cycleTasks.organizationId, orgId),
          inArray(cycleTasks.cycleId, cycleIds),
          sql`${tasks.archivedAt} is null`,
        ),
      )
      .groupBy(cycleTasks.cycleId);

    return Object.fromEntries(
      rows.map((r) => [r.cycleId, { total: r.total, done: r.done }]),
    );
  }

  async create(orgId: string, userId: string, dto: CreateCycleDto) {
    const [cycle] = await this.db
      .insert(cycles)
      .values({
        organizationId: orgId,
        spaceId: dto.spaceId,
        name: dto.name,
        description: dto.description,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        createdById: userId,
      })
      .returning();

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "cycle",
      entityId: cycle!.id,
      action: "created",
    });
    return cycle;
  }

  async tasksIn(orgId: string, cycleId: string) {
    const rows = await this.db
      .select({ taskId: cycleTasks.taskId })
      .from(cycleTasks)
      .where(
        and(eq(cycleTasks.organizationId, orgId), eq(cycleTasks.cycleId, cycleId)),
      );
    if (!rows.length) return [];

    return this.db.query.tasks.findMany({
      where: inArray(
        tasks.id,
        rows.map((r) => r.taskId),
      ),
      with: { status: true, assignees: { with: { user: true } } },
    });
  }

  /**
   * Moves a task into a cycle. The unique index on task_id means a task is only
   * ever in one cycle, so this upserts rather than accumulating rows.
   */
  async addTask(orgId: string, userId: string, cycleId: string, taskId: string) {
    const cycle = await this.db.query.cycles.findFirst({
      where: and(eq(cycles.id, cycleId), eq(cycles.organizationId, orgId)),
    });
    if (!cycle) throw new NotFoundException("Cycle not found");

    await this.db
      .insert(cycleTasks)
      .values({ cycleId, taskId, organizationId: orgId })
      .onConflictDoUpdate({ target: cycleTasks.taskId, set: { cycleId } });

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "task",
      entityId: taskId,
      action: "added_to_cycle",
      changes: [{ field: "cycle", from: null, to: cycle.name }],
    });
    return { ok: true };
  }

  async removeTask(orgId: string, userId: string, taskId: string) {
    await this.db
      .delete(cycleTasks)
      .where(and(eq(cycleTasks.organizationId, orgId), eq(cycleTasks.taskId, taskId)));

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "task",
      entityId: taskId,
      action: "removed_from_cycle",
    });
    return { ok: true };
  }
}

/** Derived rather than stored, so a cycle can't sit in a stale state. */
function cycleState(start: Date | null, end: Date | null): "upcoming" | "active" | "completed" {
  const now = Date.now();
  if (start && now < start.getTime()) return "upcoming";
  if (end && now > end.getTime()) return "completed";
  return "active";
}
