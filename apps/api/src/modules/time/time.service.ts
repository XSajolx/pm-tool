import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { lists, memberships, projects, projectStages, tasks, timeEntries, timesheetSubmissions, users } from "../../db/schema.js";
import { NotificationsService, pendingApproval } from "../notifications/notifications.service.js";
import type { Role } from "../auth/auth.types.js";

export interface Actor {
  userId: string;
  role: Role;
}

export interface StartDto {
  projectId: string;
  taskId?: string;
  /** Row 87: optional stage of the project. */
  stageId?: string;
  description?: string;
  billable?: boolean;
}

export interface ManualEntryDto extends StartDto {
  startedAt: string;
  /** Either an end time or a duration; duration wins if both are sent. */
  endedAt?: string;
  durationSeconds?: number;
}

const DAY_MS = 86_400_000;

/** Monday 00:00 UTC of the week containing `d`. The one definition of "week". */
export function startOfWeek(d: Date) {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

@Injectable()
export class TimeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly notifications: NotificationsService,
  ) {}

  /** Row 75: inbox cards decide timesheet submissions through here. */
  onModuleInit() {
    this.notifications.registerApproval("timesheet", (d) => this.decideTimesheet(d.orgId, { userId: d.userId, role: d.role as Role }, d.entityId, d.approve, d.note));
  }

  /* ---------------------------------------------------------------- *
   * Row 75: submit a week for approval
   * ---------------------------------------------------------------- */

  /** Submit my week. The approver (named, else an org owner/admin) gets an inbox card. */
  async submitWeek(orgId: string, actor: Actor, weekOf: string, approverId?: string) {
    const weekStart = startOfWeek(new Date(weekOf));
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
    const existing = await this.db.query.timesheetSubmissions.findFirst({
      where: and(eq(timesheetSubmissions.userId, actor.userId), eq(timesheetSubmissions.weekStart, weekStart)),
    });
    if (existing?.status === "approved") throw new BadRequestException("This week is already approved");
    if (existing?.status === "submitted") throw new BadRequestException("This week is already awaiting approval");

    const [sum] = await this.db
      .select({ seconds: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int` })
      .from(timeEntries)
      .where(and(eq(timeEntries.organizationId, orgId), eq(timeEntries.userId, actor.userId), gte(timeEntries.startedAt, weekStart), lt(timeEntries.startedAt, weekEnd), isNull(timeEntries.archivedAt)));
    const totalSeconds = sum?.seconds ?? 0;

    let approver = approverId ?? null;
    if (!approver) {
      const admins = await this.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.organizationId, orgId), inArray(memberships.role, ["owner", "admin"])));
      approver = admins.find((a) => a.userId !== actor.userId)?.userId ?? admins[0]?.userId ?? null;
    }
    if (!approver) throw new BadRequestException("No one can approve timesheets in this workspace yet");

    const [row] = await this.db
      .insert(timesheetSubmissions)
      .values({ organizationId: orgId, userId: actor.userId, weekStart, status: "submitted", approverId: approver, totalSeconds, note: null, submittedAt: new Date(), decidedAt: null, decidedById: null })
      .onConflictDoUpdate({
        target: [timesheetSubmissions.userId, timesheetSubmissions.weekStart],
        set: { status: "submitted", approverId: approver, totalSeconds, note: null, submittedAt: new Date(), decidedAt: null, decidedById: null },
      })
      .returning();

    const [who] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));
    const hours = Math.round((totalSeconds / 3600) * 10) / 10;
    await this.notifications.notifyDirect({
      orgId,
      receiverId: approver,
      actorId: actor.userId,
      entityType: "timesheet",
      entityId: row!.id,
      verb: "timesheet_submitted",
      title: `Timesheet: ${who?.name ?? "Someone"} - week of ${weekStart.toLocaleDateString()}`,
      body: `${hours}h logged`,
      data: { submissionId: row!.id, userId: actor.userId, weekStart: weekStart.toISOString(), approval: pendingApproval("timesheet") },
    });
    return row!;
  }

  async decideTimesheet(orgId: string, actor: Actor, id: string, approve: boolean, note?: string) {
    const sub = await this.db.query.timesheetSubmissions.findFirst({ where: and(eq(timesheetSubmissions.id, id), eq(timesheetSubmissions.organizationId, orgId)) });
    if (!sub) throw new NotFoundException("Submission not found");
    if (sub.status !== "submitted") throw new BadRequestException("This week isn't awaiting approval");
    const admin = actor.role === "owner" || actor.role === "admin";
    if (sub.approverId !== actor.userId && !admin) throw new ForbiddenException("Only the approver can decide this timesheet");
    const now = new Date();
    const [row] = await this.db
      .update(timesheetSubmissions)
      .set({ status: approve ? "approved" : "rejected", note: note?.trim() || null, decidedAt: now, decidedById: actor.userId })
      .where(eq(timesheetSubmissions.id, id))
      .returning();
    await this.notifications.resolveApproval("timesheet", id, approve ? "approved" : "rejected", note, actor.userId);
    if (sub.userId !== actor.userId) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId: sub.userId,
        actorId: actor.userId,
        entityType: "timesheet",
        entityId: id,
        verb: approve ? "timesheet_approved" : "timesheet_rejected",
        title: `Timesheet ${approve ? "approved" : "rejected"}: week of ${sub.weekStart.toLocaleDateString()}`,
        body: note?.trim() || (approve ? "Hours signed off" : "Please fix and resubmit"),
        data: { submissionId: id, weekStart: sub.weekStart.toISOString() },
      });
    }
    return row!;
  }

  /* ---------------------------------------------------------------- *
   * Timer
   * ---------------------------------------------------------------- */

  async running(orgId: string, userId: string) {
    const row = await this.db.query.timeEntries.findFirst({
      where: and(
        eq(timeEntries.organizationId, orgId),
        eq(timeEntries.userId, userId),
        isNull(timeEntries.endedAt),
      ),
      with: { project: true, task: true, stage: { columns: { id: true, name: true } } },
    });
    return row ? this.shape(row) : null;
  }

  /**
   * One running timer per person. Starting a new one stops the old one first
   * rather than refusing — the user's intent is "I'm on this now", not "error".
   */
  async start(orgId: string, userId: string, dto: StartDto) {
    await this.assertProjectAndTask(orgId, dto.projectId, dto.taskId, dto.stageId);
    await this.stop(orgId, userId);

    const [row] = await this.db
      .insert(timeEntries)
      .values({
        organizationId: orgId,
        userId,
        projectId: dto.projectId,
        taskId: dto.taskId ?? null,
        stageId: dto.stageId ?? null,
        description: dto.description ?? null,
        billable: dto.billable ?? true,
        startedAt: new Date(),
        source: "timer",
      })
      .returning();
    return this.findOne(orgId, row!.id);
  }

  async stop(orgId: string, userId: string) {
    const current = await this.db.query.timeEntries.findFirst({
      where: and(
        eq(timeEntries.organizationId, orgId),
        eq(timeEntries.userId, userId),
        isNull(timeEntries.endedAt),
      ),
    });
    if (!current) return null;

    const endedAt = new Date();
    const durationSeconds = Math.max(
      0,
      Math.round((endedAt.getTime() - current.startedAt.getTime()) / 1000),
    );
    await this.db
      .update(timeEntries)
      .set({ endedAt, durationSeconds, updatedAt: new Date() })
      .where(eq(timeEntries.id, current.id));
    return this.findOne(orgId, current.id);
  }

  /* ---------------------------------------------------------------- *
   * Entries
   * ---------------------------------------------------------------- */

  async createManual(orgId: string, userId: string, dto: ManualEntryDto) {
    await this.assertProjectAndTask(orgId, dto.projectId, dto.taskId, dto.stageId);
    const startedAt = new Date(dto.startedAt);
    const durationSeconds =
      dto.durationSeconds ??
      (dto.endedAt
        ? Math.round((new Date(dto.endedAt).getTime() - startedAt.getTime()) / 1000)
        : 0);
    if (durationSeconds <= 0) {
      throw new BadRequestException("Entry needs a positive duration or an end time");
    }

    const [row] = await this.db
      .insert(timeEntries)
      .values({
        organizationId: orgId,
        userId,
        projectId: dto.projectId,
        taskId: dto.taskId ?? null,
        stageId: dto.stageId ?? null,
        description: dto.description ?? null,
        billable: dto.billable ?? true,
        startedAt,
        endedAt: new Date(startedAt.getTime() + durationSeconds * 1000),
        durationSeconds,
        source: "manual",
      })
      .returning();
    return this.findOne(orgId, row!.id);
  }

  async update(
    orgId: string,
    actor: Actor,
    id: string,
    patch: Partial<Pick<ManualEntryDto, "description" | "billable" | "durationSeconds" | "projectId">> & {
      /** Row 87: null clears the stage. */
      stageId?: string | null;
      /** null clears the task link; undefined leaves it alone. */
      taskId?: string | null;
    },
  ) {
    const existing = await this.owned(orgId, actor, id);
    if (patch.projectId || patch.taskId !== undefined) {
      await this.assertProjectAndTask(
        orgId,
        patch.projectId ?? existing.projectId,
        patch.taskId ?? undefined,
      );
    }
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.billable !== undefined) set.billable = patch.billable;
    if (patch.projectId) set.projectId = patch.projectId;
    if (patch.taskId !== undefined) set.taskId = patch.taskId ?? null;
    if (patch.durationSeconds !== undefined && existing.endedAt) {
      set.durationSeconds = patch.durationSeconds;
      set.endedAt = new Date(existing.startedAt.getTime() + patch.durationSeconds * 1000);
    }
    await this.db.update(timeEntries).set(set).where(eq(timeEntries.id, id));
    return this.findOne(orgId, id);
  }

  async remove(orgId: string, actor: Actor, id: string) {
    await this.owned(orgId, actor, id);
    await this.db.delete(timeEntries).where(eq(timeEntries.id, id));
    return { id, deleted: true };
  }

  /** Entries in a window. Members see their own; admins may pass another user. */
  async list(
    orgId: string,
    actor: Actor,
    opts: { userId?: string; projectId?: string; from?: string; to?: string },
  ) {
    const userId = this.resolveUser(actor, opts.userId);
    const where = [eq(timeEntries.organizationId, orgId)];
    if (userId) where.push(eq(timeEntries.userId, userId));
    if (opts.projectId) where.push(eq(timeEntries.projectId, opts.projectId));
    if (opts.from) where.push(gte(timeEntries.startedAt, new Date(opts.from)));
    if (opts.to) where.push(lt(timeEntries.startedAt, new Date(opts.to)));

    const rows = await this.db.query.timeEntries.findMany({
      where: and(...where),
      with: { project: true, task: true, user: true, stage: { columns: { id: true, name: true } } },
      orderBy: desc(timeEntries.startedAt),
      limit: 500,
    });
    return rows.map((r) => this.shape(r));
  }

  /* ---------------------------------------------------------------- *
   * Timesheet
   * ---------------------------------------------------------------- */

  /**
   * A week as a grid: one row per project, seven day cells of hours, totals.
   * A still-running timer counts up to "now" so the grid matches the clock.
   */
  async timesheet(orgId: string, actor: Actor, weekOf: string, forUserId?: string) {
    const userId = this.resolveUser(actor, forUserId) ?? actor.userId;
    const weekStart = startOfWeek(new Date(weekOf));
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);

    const rows = await this.db.query.timeEntries.findMany({
      where: and(
        eq(timeEntries.organizationId, orgId),
        eq(timeEntries.userId, userId),
        gte(timeEntries.startedAt, weekStart),
        lt(timeEntries.startedAt, weekEnd),
      ),
      with: { project: true },
    });

    const byProject = new Map<
      string,
      { projectId: string; projectName: string; color: string; hours: number[] }
    >();
    for (const r of rows) {
      const day = Math.floor((r.startedAt.getTime() - weekStart.getTime()) / DAY_MS);
      const seconds = r.endedAt
        ? r.durationSeconds
        : Math.round((Date.now() - r.startedAt.getTime()) / 1000);
      let row = byProject.get(r.projectId);
      if (!row) {
        row = {
          projectId: r.projectId,
          projectName: r.project.name,
          color: r.project.color,
          hours: [0, 0, 0, 0, 0, 0, 0],
        };
        byProject.set(r.projectId, row);
      }
      row.hours[day] = (row.hours[day] ?? 0) + seconds / 3600;
    }

    const rowsOut = [...byProject.values()].map((r) => ({
      ...r,
      hours: r.hours.map((h) => round2(h)),
      total: round2(r.hours.reduce((a, b) => a + b, 0)),
    }));
    const totals = [0, 1, 2, 3, 4, 5, 6].map((i) =>
      round2(rowsOut.reduce((a, r) => a + (r.hours[i] ?? 0), 0)),
    );

    return {
      userId,
      // Row 75: where this week stands in the approval flow (null = not submitted).
      submission:
        (await this.db.query.timesheetSubmissions.findFirst({
          where: and(eq(timesheetSubmissions.userId, userId), eq(timesheetSubmissions.weekStart, weekStart)),
        })) ?? null,
      weekStart: weekStart.toISOString(),
      days: [0, 1, 2, 3, 4, 5, 6].map((i) =>
        new Date(weekStart.getTime() + i * DAY_MS).toISOString(),
      ),
      rows: rowsOut,
      totals,
      grandTotal: round2(totals.reduce((a, b) => a + b, 0)),
    };
  }

  /**
   * Writes one grid cell. The typed value is the day's *total* for that project.
   * Time the timer or a manual entry already recorded stays untouched — the
   * grid's own entry (`source = timesheet`) absorbs only the difference — so the
   * cell shows exactly what was typed and nothing tracked live is rewritten.
   */
  async setTimesheetCell(
    orgId: string,
    actor: Actor,
    dto: { projectId: string; date: string; hours: number; userId?: string },
  ) {
    const userId = this.resolveUser(actor, dto.userId) ?? actor.userId;
    await this.assertProjectAndTask(orgId, dto.projectId);

    const day = new Date(dto.date);
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);

    const existing = await this.db.query.timeEntries.findMany({
      where: and(
        eq(timeEntries.organizationId, orgId),
        eq(timeEntries.userId, userId),
        eq(timeEntries.projectId, dto.projectId),
        eq(timeEntries.source, "timesheet"),
        gte(timeEntries.startedAt, dayStart),
        lt(timeEntries.startedAt, dayEnd),
      ),
    });

    const [otherRow] = await this.db
      .select({
        seconds: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int`,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.organizationId, orgId),
          eq(timeEntries.userId, userId),
          eq(timeEntries.projectId, dto.projectId),
          sql`${timeEntries.source} <> 'timesheet'`,
          gte(timeEntries.startedAt, dayStart),
          lt(timeEntries.startedAt, dayEnd),
        ),
      );
    const seconds = Math.round(dto.hours * 3600) - (otherRow?.seconds ?? 0);
    if (seconds <= 0) {
      for (const e of existing) await this.db.delete(timeEntries).where(eq(timeEntries.id, e.id));
      return { ok: true };
    }

    const startedAt = new Date(dayStart.getTime() + 9 * 3_600_000); // 09:00 UTC, arbitrary but stable
    const endedAt = new Date(startedAt.getTime() + seconds * 1000);
    const [first, ...extra] = existing;
    if (first) {
      await this.db
        .update(timeEntries)
        .set({ durationSeconds: seconds, endedAt, updatedAt: new Date() })
        .where(eq(timeEntries.id, first.id));
      for (const e of extra) await this.db.delete(timeEntries).where(eq(timeEntries.id, e.id));
    } else {
      await this.db.insert(timeEntries).values({
        organizationId: orgId,
        userId,
        projectId: dto.projectId,
        startedAt,
        endedAt,
        durationSeconds: seconds,
        source: "timesheet",
      });
    }
    return { ok: true };
  }

  /* ---------------------------------------------------------------- *
   * Summaries
   * ---------------------------------------------------------------- */

  async projectSummary(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
    });
    if (!project) throw new NotFoundException("Project not found");

    const byUser = await this.db
      .select({
        userId: timeEntries.userId,
        name: users.name,
        seconds: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int`,
        billable: sql<number>`coalesce(sum(${timeEntries.durationSeconds}) filter (where ${timeEntries.billable}), 0)::int`,
      })
      .from(timeEntries)
      .innerJoin(users, eq(users.id, timeEntries.userId))
      .where(eq(timeEntries.projectId, projectId))
      .groupBy(timeEntries.userId, users.name);

    const seconds = byUser.reduce((a, r) => a + r.seconds, 0);
    const billable = byUser.reduce((a, r) => a + r.billable, 0);
    return {
      projectId,
      loggedSeconds: seconds,
      billableSeconds: billable,
      billableAmount: project.hourlyRate ? round2((billable / 3600) * project.hourlyRate) : null,
      budgetHours: project.budgetHours,
      budgetAmount: project.budgetAmount,
      byUser,
    };
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  private async findOne(orgId: string, id: string) {
    const row = await this.db.query.timeEntries.findFirst({
      where: and(eq(timeEntries.id, id), eq(timeEntries.organizationId, orgId)),
      with: { project: true, task: true, user: true, stage: { columns: { id: true, name: true } } },
    });
    if (!row) throw new NotFoundException("Time entry not found");
    return this.shape(row);
  }

  /** You may edit your own entries; owners and admins may edit anyone's. */
  private async owned(orgId: string, actor: Actor, id: string) {
    const row = await this.db.query.timeEntries.findFirst({
      where: and(eq(timeEntries.id, id), eq(timeEntries.organizationId, orgId)),
    });
    if (!row) throw new NotFoundException("Time entry not found");
    const isAdmin = actor.role === "owner" || actor.role === "admin";
    if (row.userId !== actor.userId && !isAdmin) {
      throw new ForbiddenException("You can only change your own time entries");
    }
    return row;
  }

  /** Members may only look at themselves; admins may ask for anyone. */
  private resolveUser(actor: Actor, requested?: string) {
    if (!requested || requested === actor.userId) return requested;
    if (actor.role === "owner" || actor.role === "admin") return requested;
    throw new ForbiddenException("Only admins can view other people's time");
  }

  /** Project must be in this org; task (if given) must live in the project's space. */
  private async assertProjectAndTask(orgId: string, projectId: string, taskId?: string, stageId?: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
    });
    if (!project) throw new BadRequestException("Project not found in this organization");
    // Row 87: a stage, when given, must be one of this project's stages.
    if (stageId) {
      const stage = await this.db.query.projectStages.findFirst({ where: and(eq(projectStages.id, stageId), eq(projectStages.projectId, projectId)), columns: { id: true } });
      if (!stage) throw new BadRequestException("Stage does not belong to this project");
    }
    if (!taskId) return project;

    const [row] = await this.db
      .select({ spaceId: lists.spaceId })
      .from(tasks)
      .innerJoin(lists, eq(lists.id, tasks.listId))
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)));
    if (!row || row.spaceId !== project.spaceId) {
      throw new BadRequestException("Task does not belong to this project");
    }
    return project;
  }

  private shape(r: {
    id: string;
    userId: string;
    projectId: string;
    taskId: string | null;
    description: string | null;
    startedAt: Date;
    endedAt: Date | null;
    durationSeconds: number;
    billable: boolean;
    source: string;
    project: { id: string; name: string; color: string };
    task?: { id: string; title: string; reference: string | null } | null;
    user?: { id: string; name: string } | null;
    stage?: { id: string; name: string } | null;
  }) {
    return {
      id: r.id,
      userId: r.userId,
      projectId: r.projectId,
      taskId: r.taskId,
      description: r.description,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationSeconds: r.endedAt
        ? r.durationSeconds
        : Math.round((Date.now() - r.startedAt.getTime()) / 1000),
      running: !r.endedAt,
      billable: r.billable,
      source: r.source,
      project: { id: r.project.id, name: r.project.name, color: r.project.color },
      task: r.task ? { id: r.task.id, title: r.task.title, reference: r.task.reference } : null,
      user: r.user ? { id: r.user.id, name: r.user.name } : null,
      stage: r.stage ? { id: r.stage.id, name: r.stage.name } : null,
    };
  }

  /** Row 87: open tasks in a project's space, for the "log time against a task" picker. */
  async pickableTasks(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { spaceId: true } });
    if (!project?.spaceId) return [];
    const rows = await this.db
      .select({ id: tasks.id, title: tasks.title, reference: tasks.reference })
      .from(tasks)
      .innerJoin(lists, eq(lists.id, tasks.listId))
      .where(and(eq(tasks.organizationId, orgId), eq(lists.spaceId, project.spaceId), isNull(tasks.completedAt), isNull(tasks.archivedAt), isNull(tasks.parentTaskId)))
      .orderBy(desc(tasks.updatedAt))
      .limit(200);
    return rows;
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
