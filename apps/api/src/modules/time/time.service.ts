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
import { lists, memberships, projects, projectStages, tasks, timeEntries, timesheetEvents, timesheetSubmissions, users } from "../../db/schema.js";
import { NotificationsService, pendingApproval } from "../notifications/notifications.service.js";
import { accessEnded } from "../auth/auth.service.js";
import type { Role } from "../auth/auth.types.js";

export interface Actor {
  userId: string;
  role: Role;
}

export interface StartDto {
  /** Row 90: optional when a task is given - the task's project is used. */
  projectId?: string;
  taskId?: string;
  /** Row 87: optional stage of the project. */
  stageId?: string;
  description?: string;
  billable?: boolean;
}

export interface ManualEntryDto extends StartDto {
  /** Manual entries always name the project. */
  projectId: string;
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
    if (existing?.status === "approved") throw new BadRequestException("This week is already approved - ask a project manager to unlock it first");
    if (existing?.status === "submitted") throw new BadRequestException("This week is already awaiting approval");
    // Row 93: a week that was sent back or unlocked comes back as a resubmission.
    const resubmit = existing?.status === "rejected" || existing?.status === "reopened";

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

    await this.db.insert(timesheetEvents).values({ submissionId: row!.id, kind: resubmit ? "resubmitted" : "submitted", actorId: actor.userId, note: null });
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
    await this.db.insert(timesheetEvents).values({ submissionId: id, kind: approve ? "approved" : "rejected", actorId: actor.userId, note: note?.trim() || null });
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
    // Row 90: "start from any task card" - the project is implied by the task.
    const projectId = dto.projectId ?? (dto.taskId ? await this.projectForTask(orgId, dto.taskId) : null);
    if (!projectId) throw new BadRequestException("Pick a project or a task to track time on");
    const project = await this.assertProjectAndTask(orgId, projectId, dto.taskId, dto.stageId);
    await this.assertWeekUnlocked(orgId, userId, new Date());
    // One running timer per person: starting a new one stops the old one.
    await this.stop(orgId, userId);

    const [row] = await this.db
      .insert(timeEntries)
      .values({
        organizationId: orgId,
        userId,
        projectId,
        taskId: dto.taskId ?? null,
        stageId: dto.stageId ?? null,
        description: dto.description ?? null,
        // Row 91: internal codes are never billable.
        billable: project.kind === "internal" ? false : (dto.billable ?? true),
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
    const project = await this.assertProjectAndTask(orgId, dto.projectId, dto.taskId, dto.stageId);
    const startedAt = new Date(dto.startedAt);
    await this.assertWeekUnlocked(orgId, userId, startedAt);
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
        billable: project.kind === "internal" ? false : (dto.billable ?? true),
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
    await this.assertWeekUnlocked(orgId, existing.userId, existing.startedAt);
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
    const existing = await this.owned(orgId, actor, id);
    await this.assertWeekUnlocked(orgId, existing.userId, existing.startedAt);
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
      with: { project: true, task: { columns: { id: true, title: true, reference: true } } },
    });

    // Row 88: one row per project *or* project+task, so a week can be typed in straight.
    const byProject = new Map<
      string,
      { projectId: string; projectName: string; color: string; internal: boolean; taskId: string | null; taskTitle: string | null; taskReference: string | null; hours: number[] }
    >();
    for (const r of rows) {
      const day = Math.floor((r.startedAt.getTime() - weekStart.getTime()) / DAY_MS);
      const seconds = r.endedAt
        ? r.durationSeconds
        : Math.round((Date.now() - r.startedAt.getTime()) / 1000);
      const key = `${r.projectId}:${r.taskId ?? ""}`;
      let row = byProject.get(key);
      if (!row) {
        row = {
          projectId: r.projectId,
          projectName: r.project.name,
          color: r.project.color,
          internal: r.project.kind === "internal",
          taskId: r.taskId ?? null,
          taskTitle: r.task?.title ?? null,
          taskReference: r.task?.reference ?? null,
          hours: [0, 0, 0, 0, 0, 0, 0],
        };
        byProject.set(key, row);
      }
      row.hours[day] = (row.hours[day] ?? 0) + seconds / 3600;
    }
    // Row 88: "29/40" in the header - expected hours come from the person's weekly capacity.
    const membership = await this.db.query.memberships.findFirst({ where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)), columns: { weeklyCapacityHours: true } });

    const rowsOut = [...byProject.values()]
      .map((r) => ({
        ...r,
        hours: r.hours.map((h) => round2(h)),
        total: round2(r.hours.reduce((a, b) => a + b, 0)),
      }))
      .sort((a, b) => a.projectName.localeCompare(b.projectName) || (a.taskId ? 1 : 0) - (b.taskId ? 1 : 0) || (a.taskTitle ?? "").localeCompare(b.taskTitle ?? ""));
    const totals = [0, 1, 2, 3, 4, 5, 6].map((i) =>
      round2(rowsOut.reduce((a, r) => a + (r.hours[i] ?? 0), 0)),
    );

    return {
      userId,
      // Row 75: where this week stands in the approval flow (null = not submitted).
      submission:
        (await this.db.query.timesheetSubmissions.findFirst({
          where: and(eq(timesheetSubmissions.userId, userId), eq(timesheetSubmissions.weekStart, weekStart)),
          with: { decidedBy: { columns: { id: true, name: true } } },
        })) ?? null,
      weekStart: weekStart.toISOString(),
      days: [0, 1, 2, 3, 4, 5, 6].map((i) =>
        new Date(weekStart.getTime() + i * DAY_MS).toISOString(),
      ),
      rows: rowsOut,
      totals,
      grandTotal: round2(totals.reduce((a, b) => a + b, 0)),
      expectedHours: membership?.weeklyCapacityHours ?? 40,
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
    dto: { projectId: string; taskId?: string | null; date: string; hours: number; userId?: string },
  ) {
    const userId = this.resolveUser(actor, dto.userId) ?? actor.userId;
    await this.assertProjectAndTask(orgId, dto.projectId, dto.taskId ?? undefined);
    await this.assertWeekUnlocked(orgId, userId, new Date(dto.date));
    // Row 88: a cell is (project, task-or-none, day).
    const taskMatch = dto.taskId ? eq(timeEntries.taskId, dto.taskId) : isNull(timeEntries.taskId);

    const day = new Date(dto.date);
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);

    const existing = await this.db.query.timeEntries.findMany({
      where: and(
        eq(timeEntries.organizationId, orgId),
        eq(timeEntries.userId, userId),
        eq(timeEntries.projectId, dto.projectId),
        taskMatch,
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
          taskMatch,
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
      const proj = await this.db.query.projects.findFirst({ where: eq(projects.id, dto.projectId), columns: { kind: true } });
      await this.db.insert(timeEntries).values({
        organizationId: orgId,
        userId,
        projectId: dto.projectId,
        taskId: dto.taskId ?? null,
        startedAt,
        endedAt,
        durationSeconds: seconds,
        billable: proj?.kind !== "internal",
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
  /**
   * Row 97: week-by-person status board for project managers. Status is
   * derived: approved / submitted / rejected / reopened come from the
   * submission; otherwise "in_progress" when hours exist, "not_started" when not.
   */
  async teamBoard(orgId: string, weekOf: string) {
    const weekStart = startOfWeek(new Date(weekOf));
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
    const members = await this.db.query.memberships.findMany({ where: eq(memberships.organizationId, orgId), with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } });
    const active = members.filter((m) => !accessEnded(m) && m.role !== "guest");
    const ids = active.map((m) => m.userId);
    if (!ids.length) return { weekStart: weekStart.toISOString(), people: [] };
    const [hoursRows, subs] = await Promise.all([
      this.db
        .select({ userId: timeEntries.userId, seconds: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int`, billable: sql<number>`coalesce(sum(case when ${timeEntries.billable} then ${timeEntries.durationSeconds} else 0 end), 0)::int` })
        .from(timeEntries)
        .where(and(eq(timeEntries.organizationId, orgId), inArray(timeEntries.userId, ids), gte(timeEntries.startedAt, weekStart), lt(timeEntries.startedAt, weekEnd), isNull(timeEntries.archivedAt)))
        .groupBy(timeEntries.userId),
      this.db.query.timesheetSubmissions.findMany({ where: and(eq(timesheetSubmissions.organizationId, orgId), eq(timesheetSubmissions.weekStart, weekStart), inArray(timesheetSubmissions.userId, ids)) }),
    ]);
    const hoursBy = new Map(hoursRows.map((h) => [h.userId, h]));
    const subBy = new Map(subs.map((s) => [s.userId, s]));
    const order = { rejected: 0, reopened: 1, not_started: 2, in_progress: 3, submitted: 4, approved: 5 } as const;
    const people = active.map((m) => {
      const h = hoursBy.get(m.userId);
      const hours = Math.round(((h?.seconds ?? 0) / 3600) * 10) / 10;
      const sub = subBy.get(m.userId);
      const status = (sub?.status as keyof typeof order | undefined) ?? (hours > 0 ? "in_progress" : "not_started");
      return {
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        hours,
        billableHours: Math.round(((h?.billable ?? 0) / 3600) * 10) / 10,
        expected: m.weeklyCapacityHours,
        status,
        submissionId: sub?.id ?? null,
        submittedAt: sub?.submittedAt ?? null,
        decidedAt: sub?.decidedAt ?? null,
        note: sub?.note ?? null,
      };
    });
    people.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    return { weekStart: weekStart.toISOString(), people };
  }

  /**
   * Row 103: each teammate's hours this week split project / internal / leave,
   * against their expected hours - the numbers behind the workload widget.
   */
  async workload(orgId: string, weekOf: string, onlyUserId?: string) {
    const weekStart = startOfWeek(new Date(weekOf));
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
    const members = await this.db.query.memberships.findMany({ where: eq(memberships.organizationId, orgId), with: { user: { columns: { id: true, name: true, avatarUrl: true } } } });
    const active = members.filter((m) => !accessEnded(m) && m.role !== "guest" && (!onlyUserId || m.userId === onlyUserId));
    const ids = active.map((m) => m.userId);
    if (!ids.length) return { weekStart: weekStart.toISOString(), people: [] };
    const rows = await this.db
      .select({
        userId: timeEntries.userId,
        projectId: timeEntries.projectId,
        projectName: projects.name,
        projectColor: projects.color,
        kind: projects.kind,
        source: timeEntries.source,
        seconds: sql<number>`coalesce(sum(case when ${timeEntries.endedAt} is null then extract(epoch from (now() - ${timeEntries.startedAt})) else ${timeEntries.durationSeconds} end), 0)::int`,
      })
      .from(timeEntries)
      .leftJoin(projects, eq(projects.id, timeEntries.projectId))
      .where(and(eq(timeEntries.organizationId, orgId), inArray(timeEntries.userId, ids), gte(timeEntries.startedAt, weekStart), lt(timeEntries.startedAt, weekEnd), isNull(timeEntries.archivedAt)))
      .groupBy(timeEntries.userId, timeEntries.projectId, projects.name, projects.color, projects.kind, timeEntries.source);
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    const h = (sec: number) => Math.round((sec / 3600) * 10) / 10;
    const people = active.map((m) => {
      const mine = byUser.get(m.userId) ?? [];
      let project = 0, internal = 0, leave = 0;
      const projectsMap = new Map<string, { id: string; name: string; color: string | null; seconds: number }>();
      for (const row of mine) {
        if (row.source === "leave") leave += row.seconds;
        else if (row.kind === "internal") internal += row.seconds;
        else {
          project += row.seconds;
          const key = row.projectId ?? "none";
          const cur = projectsMap.get(key) ?? { id: key, name: row.projectName ?? "No project", color: row.projectColor ?? null, seconds: 0 };
          cur.seconds += row.seconds;
          projectsMap.set(key, cur);
        }
      }
      const total = project + internal + leave;
      return {
        userId: m.userId,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
        expected: m.weeklyCapacityHours,
        projectHours: h(project),
        internalHours: h(internal),
        leaveHours: h(leave),
        totalHours: h(total),
        projects: [...projectsMap.values()].sort((a, b) => b.seconds - a.seconds).map((x) => ({ ...x, hours: h(x.seconds) })),
      };
    });
    people.sort((a, b) => b.totalHours / Math.max(1, b.expected) - a.totalHours / Math.max(1, a.expected) || a.name.localeCompare(b.name));
    return { weekStart: weekStart.toISOString(), people };
  }

  /** Row 97: chase one person about one week. */
  async nudge(orgId: string, actor: Actor, userId: string, weekOf: string) {
    const weekStart = startOfWeek(new Date(weekOf));
    const board = await this.teamBoard(orgId, weekOf);
    const p = board.people.find((x) => x.userId === userId);
    if (!p) throw new NotFoundException("That person isn't on the board");
    const [who] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));
    const missing = Math.max(0, Math.round((p.expected - p.hours) * 10) / 10);
    await this.notifications.notifyDirect({
      orgId,
      receiverId: userId,
      actorId: actor.userId,
      entityType: "timesheet",
      entityId: userId,
      verb: "timesheet_reminder",
      title: `${who?.name ?? "Your project manager"} is waiting on your timesheet`,
      body: `Week of ${weekStart.toLocaleDateString()}: ${p.hours}h of ${p.expected}h logged${missing ? ` (${missing}h to go)` : ""}${p.status === "submitted" || p.status === "approved" ? "" : " - please submit it"}`,
      data: { weekStart: weekStart.toISOString(), link: "/timesheets" },
    });
    return { nudged: userId };
  }

  /**
   * Row 93: a project manager unlocks an approved week with a reason. The
   * hours become editable again, the member is told why, and the week must be
   * resubmitted and re-approved. Everything lands in the trail.
   */
  async reopenTimesheet(orgId: string, actor: Actor, id: string, reason: string) {
    const sub = await this.db.query.timesheetSubmissions.findFirst({ where: and(eq(timesheetSubmissions.id, id), eq(timesheetSubmissions.organizationId, orgId)) });
    if (!sub) throw new NotFoundException("Submission not found");
    if (sub.status !== "approved") throw new BadRequestException("Only an approved week can be unlocked");
    const admin = actor.role === "owner" || actor.role === "admin";
    if (!admin && sub.approverId !== actor.userId) throw new ForbiddenException("Only a project manager can unlock an approved week");
    const why = reason.trim();
    if (!why) throw new BadRequestException("Say why the week is being unlocked");
    const now = new Date();
    const [row] = await this.db
      .update(timesheetSubmissions)
      .set({ status: "reopened", note: why, decidedAt: now, decidedById: actor.userId })
      .where(eq(timesheetSubmissions.id, id))
      .returning();
    await this.db.insert(timesheetEvents).values({ submissionId: id, kind: "reopened", actorId: actor.userId, note: why });
    if (sub.userId !== actor.userId) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId: sub.userId,
        actorId: actor.userId,
        entityType: "timesheet",
        entityId: id,
        verb: "timesheet_reopened",
        title: `Timesheet unlocked for correction: week of ${sub.weekStart.toLocaleDateString()}`,
        body: why,
        data: { submissionId: id, weekStart: sub.weekStart.toISOString() },
      });
    }
    return row!;
  }

  /** Row 93: the trail for a week. */
  async timesheetEvents(orgId: string, actor: Actor, id: string) {
    const sub = await this.db.query.timesheetSubmissions.findFirst({ where: and(eq(timesheetSubmissions.id, id), eq(timesheetSubmissions.organizationId, orgId)), columns: { userId: true } });
    if (!sub) throw new NotFoundException("Submission not found");
    this.resolveUser(actor, sub.userId);
    const rows = await this.db.query.timesheetEvents.findMany({
      where: eq(timesheetEvents.submissionId, id),
      with: { actor: { columns: { id: true, name: true } } },
      orderBy: [desc(timesheetEvents.createdAt)],
    });
    return rows.map((e) => ({ id: e.id, kind: e.kind, note: e.note, createdAt: e.createdAt, actor: e.actor }));
  }

  /**
   * Row 92: once a week is approved its hours are locked - no new entries, edits
   * or deletions for that person in that week until a project manager unlocks it
   * (row 93). Rejected / submitted weeks stay editable.
   */
  private async assertWeekUnlocked(orgId: string, userId: string, at: Date) {
    const weekStart = startOfWeek(at);
    const sub = await this.db.query.timesheetSubmissions.findFirst({
      where: and(eq(timesheetSubmissions.organizationId, orgId), eq(timesheetSubmissions.userId, userId), eq(timesheetSubmissions.weekStart, weekStart)),
      columns: { status: true },
    });
    if (sub?.status === "approved") {
      throw new ForbiddenException(`The week of ${weekStart.toLocaleDateString()} is approved and locked - ask a project manager to unlock it before changing hours`);
    }
  }

  /** Row 90: the project that owns a task (task → list → space → project), or null. */
  private async projectForTask(orgId: string, taskId: string) {
    const [row] = await this.db
      .select({ spaceId: lists.spaceId })
      .from(tasks)
      .innerJoin(lists, eq(lists.id, tasks.listId))
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)));
    if (!row) throw new BadRequestException("Task not found");
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.spaceId, row.spaceId), eq(projects.organizationId, orgId), isNull(projects.archivedAt)), columns: { id: true } });
    return project?.id ?? null;
  }

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
