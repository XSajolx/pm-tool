import { BadRequestException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { allocations, holidays, leaveRequests, memberships, organizations, projectStages, projects, reminders, timeEntries, users } from "../../db/schema.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { startOfWeek } from "../time/time.service.js";

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
const NONE = "";

type StageMap = Record<string, Record<string, number>>; // projectId -> stageId|'' -> hours

/**
 * Capacity planning. The board is people × weeks; each cell compares hours
 * *planned* on projects — per stage since row 147 — with the person's
 * *available* hours that week (capacity − holidays − approved leave), and
 * shows hours *actually logged*, also per stage, beside it (row 149).
 * Row 148: the moment a week is planned past what someone has available,
 * the project managers get one inbox alert for that person + week — never a
 * second one.
 */
@Injectable()
export class ResourcingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResourcingService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // Capacity and leave change without anyone touching the plan: re-check daily.
    this.timer = setInterval(() => void this.sweepOverAllocation(), 24 * 60 * 60 * 1000);
    setTimeout(() => void this.sweepOverAllocation(), 40_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------------- availability ---------------- */

  /** Available hours per person for each week: capacity − company holidays − approved leave, on their working days. */
  private async availability(orgId: string, weekStarts: Date[], people: { userId: string; capacity: number; workingDays: number[] | null }[]) {
    if (!weekStarts.length || !people.length) return new Map<string, number>();
    const from = weekStarts[0]!;
    const to = new Date(weekStarts[weekStarts.length - 1]!.getTime() + WEEK_MS);
    const [org, offDays, leave] = await Promise.all([
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { workingDays: true } }),
      this.db.query.holidays.findMany({ where: and(eq(holidays.organizationId, orgId), gte(holidays.date, from), lt(holidays.date, to)) }),
      this.db.query.leaveRequests.findMany({ where: and(eq(leaveRequests.organizationId, orgId), eq(leaveRequests.status, "approved"), lt(leaveRequests.startDate, to), gte(leaveRequests.endDate, from)) }),
    ]);
    const orgDays = org?.workingDays ?? [1, 2, 3, 4, 5];
    const holidaySet = new Set(offDays.map((h) => h.date.toISOString().slice(0, 10)));
    const out = new Map<string, number>();
    for (const p of people) {
      const working = p.workingDays?.length ? p.workingDays : orgDays;
      const perDay = working.length ? p.capacity / working.length : 0;
      for (const w of weekStarts) {
        let avail = 0;
        for (let i = 0; i < 7; i++) {
          const d = new Date(w.getTime() + i * DAY_MS);
          if (!working.includes(d.getUTCDay())) continue;
          if (holidaySet.has(d.toISOString().slice(0, 10))) continue;
          const onLeave = leave.find((l) => l.userId === p.userId && l.startDate <= d && l.endDate >= d);
          avail += onLeave ? Math.max(0, perDay - Math.min(perDay, onLeave.hoursPerDay)) : perDay;
        }
        out.set(`${p.userId}|${w.toISOString().slice(0, 10)}`, Math.round(avail * 10) / 10);
      }
    }
    return out;
  }

  /* ---------------- the board ---------------- */

  async board(orgId: string, fromWeek: string, weeks = 12) {
    const count = Math.min(Math.max(weeks, 1), 26);
    const start = startOfWeek(new Date(fromWeek));
    const end = new Date(start.getTime() + count * WEEK_MS);
    const weekStarts = Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * WEEK_MS));

    const [people, activeProjects, stages, planned, logged] = await Promise.all([
      this.db
        .select({ userId: users.id, name: users.name, role: memberships.role, capacity: memberships.weeklyCapacityHours, workingDays: memberships.workingDays })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.organizationId, orgId), isNull(memberships.deactivatedAt))),
      this.db.select({ id: projects.id, name: projects.name, color: projects.color, kind: projects.kind }).from(projects).where(and(eq(projects.organizationId, orgId), isNull(projects.archivedAt), sql`${projects.status} <> 'archived'`)),
      this.db.select({ id: projectStages.id, projectId: projectStages.projectId, name: projectStages.name, status: projectStages.status, position: projectStages.position }).from(projectStages).where(and(eq(projectStages.organizationId, orgId), isNull(projectStages.archivedAt))),
      this.db.select().from(allocations).where(and(eq(allocations.organizationId, orgId), gte(allocations.weekStart, start), lt(allocations.weekStart, end))),
      // Logged hours bucketed to the Monday of their week, per person / project / stage.
      // Returned as a plain YYYY-MM-DD string so it keys identically to `weekStarts` —
      // parsing a zone-less timestamp with `new Date` would shift it into the server's zone.
      this.db
        .select({
          userId: timeEntries.userId,
          projectId: timeEntries.projectId,
          stageId: timeEntries.stageId,
          weekStart: sql<string>`to_char(date_trunc('week', ${timeEntries.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          seconds: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int`,
        })
        .from(timeEntries)
        .where(and(eq(timeEntries.organizationId, orgId), gte(timeEntries.startedAt, start), lt(timeEntries.startedAt, end)))
        .groupBy(timeEntries.userId, timeEntries.projectId, timeEntries.stageId, sql`date_trunc('week', ${timeEntries.startedAt} at time zone 'UTC')`),
    ]);
    const available = await this.availability(orgId, weekStarts, people);

    const key = (userId: string, week: Date | string) => `${userId}|${typeof week === "string" ? week : week.toISOString().slice(0, 10)}`;
    const plannedByCell = new Map<string, { total: number; byProject: Record<string, number>; byStage: StageMap }>();
    for (const a of planned) {
      const k = key(a.userId, a.weekStart);
      const cell = plannedByCell.get(k) ?? { total: 0, byProject: {}, byStage: {} };
      cell.total += a.hours;
      cell.byProject[a.projectId] = round2((cell.byProject[a.projectId] ?? 0) + a.hours);
      const st = (cell.byStage[a.projectId] ??= {});
      st[a.stageId ?? NONE] = round2((st[a.stageId ?? NONE] ?? 0) + a.hours);
      plannedByCell.set(k, cell);
    }
    const loggedByCell = new Map<string, { total: number; byProject: Record<string, number>; byStage: StageMap }>();
    for (const l of logged) {
      const k = key(l.userId, l.weekStart);
      const cell = loggedByCell.get(k) ?? { total: 0, byProject: {}, byStage: {} };
      const h = l.seconds / 3600;
      cell.total += h;
      cell.byProject[l.projectId] = round2((cell.byProject[l.projectId] ?? 0) + h);
      const st = (cell.byStage[l.projectId] ??= {});
      st[l.stageId ?? NONE] = round2((st[l.stageId ?? NONE] ?? 0) + h);
      loggedByCell.set(k, cell);
    }

    return {
      weeks: weekStarts.map((w) => w.toISOString()),
      projects: activeProjects
        .filter((p) => p.kind !== "internal")
        .map((p) => ({ id: p.id, name: p.name, color: p.color, stages: stages.filter((s) => s.projectId === p.id).sort((a, b) => a.position - b.position).map((s) => ({ id: s.id, name: s.name, status: s.status })) })),
      members: people.map((p) => ({
        userId: p.userId,
        name: p.name,
        role: p.role,
        capacity: p.capacity,
        cells: weekStarts.map((w) => {
          const plan = plannedByCell.get(key(p.userId, w));
          const log = loggedByCell.get(key(p.userId, w));
          const allocated = round2(plan?.total ?? 0);
          const avail = available.get(key(p.userId, w)) ?? p.capacity;
          return {
            weekStart: w.toISOString(),
            allocated,
            available: avail,
            logged: round2(log?.total ?? 0),
            utilization: avail ? round2(allocated / avail) : allocated > 0 ? 9.99 : 0,
            over: allocated > avail + 0.05,
            byProject: plan?.byProject ?? {},
            byStage: plan?.byStage ?? {},
            loggedByProject: log?.byProject ?? {},
            loggedByStage: log?.byStage ?? {},
          };
        }),
      })),
    };
  }

  /** Row 149: one project's plan vs reality, per person and stage, over the visible weeks. */
  async projectPlanVsLogged(orgId: string, projectId: string, fromWeek: string, weeks = 12) {
    const b = await this.board(orgId, fromWeek, weeks);
    const project = b.projects.find((p) => p.id === projectId);
    if (!project) throw new BadRequestException("Project not found or archived");
    const stageName = (id: string) => (id === NONE ? "No stage" : project.stages.find((s) => s.id === id)?.name ?? "Removed stage");
    const rows: { userId: string; name: string; stageId: string; stage: string; planned: number; logged: number; weeks: { weekStart: string; planned: number; logged: number }[] }[] = [];
    for (const m of b.members) {
      const stageIds = new Set<string>();
      for (const c of m.cells) {
        for (const k of Object.keys(c.byStage[projectId] ?? {})) stageIds.add(k);
        for (const k of Object.keys(c.loggedByStage[projectId] ?? {})) stageIds.add(k);
      }
      for (const sid of stageIds) {
        const wk = m.cells.map((c) => ({ weekStart: c.weekStart, planned: c.byStage[projectId]?.[sid] ?? 0, logged: c.loggedByStage[projectId]?.[sid] ?? 0 }));
        rows.push({ userId: m.userId, name: m.name, stageId: sid, stage: stageName(sid), planned: round2(wk.reduce((a, w) => a + w.planned, 0)), logged: round2(wk.reduce((a, w) => a + w.logged, 0)), weeks: wk });
      }
    }
    const byStage = project.stages.map((s) => ({ id: s.id, name: s.name, planned: round2(rows.filter((r) => r.stageId === s.id).reduce((a, r) => a + r.planned, 0)), logged: round2(rows.filter((r) => r.stageId === s.id).reduce((a, r) => a + r.logged, 0)) }));
    const none = rows.filter((r) => r.stageId === NONE);
    if (none.length) byStage.push({ id: NONE, name: "No stage", planned: round2(none.reduce((a, r) => a + r.planned, 0)), logged: round2(none.reduce((a, r) => a + r.logged, 0)) });
    return { project: { id: project.id, name: project.name, color: project.color }, weeks: b.weeks, rows: rows.sort((a, b) => a.name.localeCompare(b.name) || a.stage.localeCompare(b.stage)), byStage };
  }

  /** Upsert one (person, project, stage, week). Zero hours removes the row. */
  async setAllocation(orgId: string, actorId: string, dto: { userId: string; projectId: string; stageId?: string | null; weekStart: string; hours: number; note?: string }) {
    const [member, project] = await Promise.all([
      this.db.query.memberships.findFirst({ where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, dto.userId)) }),
      this.db.query.projects.findFirst({ where: and(eq(projects.id, dto.projectId), eq(projects.organizationId, orgId)) }),
    ]);
    if (!member) throw new BadRequestException("That person is not a member of this organization");
    if (!project) throw new BadRequestException("Project not found in this organization");
    const stageId = dto.stageId || null;
    if (stageId) {
      const st = await this.db.query.projectStages.findFirst({ where: and(eq(projectStages.id, stageId), eq(projectStages.projectId, project.id)), columns: { id: true } });
      if (!st) throw new BadRequestException("That stage is not on this project");
    }
    const weekStart = startOfWeek(new Date(dto.weekStart));
    const stageWhere = stageId ? eq(allocations.stageId, stageId) : isNull(allocations.stageId);
    const where = and(eq(allocations.userId, dto.userId), eq(allocations.projectId, dto.projectId), eq(allocations.weekStart, weekStart), stageWhere);

    if (dto.hours <= 0) {
      await this.db.delete(allocations).where(where);
    } else {
      const existing = await this.db.query.allocations.findFirst({ where, columns: { id: true } });
      if (existing) await this.db.update(allocations).set({ hours: dto.hours, note: dto.note ?? null, updatedAt: new Date() }).where(eq(allocations.id, existing.id));
      else await this.db.insert(allocations).values({ organizationId: orgId, userId: dto.userId, projectId: dto.projectId, stageId, weekStart, hours: dto.hours, note: dto.note ?? null, createdById: actorId });
    }
    // Row 148: check this person + week right away.
    await this.checkOverAllocation(orgId, dto.userId, weekStart).catch((err) => this.logger.warn(`over-allocation check failed: ${(err as Error).message}`));
    return { ok: true };
  }

  async setCapacity(orgId: string, userId: string, hours: number) {
    const [row] = await this.db
      .update(memberships)
      .set({ weeklyCapacityHours: hours, updatedAt: new Date() })
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
      .returning();
    if (!row) throw new BadRequestException("That person is not a member of this organization");
    return { userId, weeklyCapacityHours: row.weeklyCapacityHours };
  }

  /** Raw allocations for a set of people, for the grid's edit popover. */
  async allocationsFor(orgId: string, userIds: string[], fromWeek: string, weeks = 12) {
    const start = startOfWeek(new Date(fromWeek));
    const end = new Date(start.getTime() + Math.min(Math.max(weeks, 1), 26) * WEEK_MS);
    if (!userIds.length) return [];
    return this.db
      .select()
      .from(allocations)
      .where(and(eq(allocations.organizationId, orgId), inArray(allocations.userId, userIds), gte(allocations.weekStart, start), lt(allocations.weekStart, end)));
  }

  /* ---------------- row 148: over-allocation alerts ---------------- */

  /** One alert per (person, week) to the project managers, when planned > available. Never repeated. */
  async checkOverAllocation(orgId: string, userId: string, weekStart: Date) {
    const [person] = await this.db
      .select({ userId: users.id, name: users.name, capacity: memberships.weeklyCapacityHours, workingDays: memberships.workingDays })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)));
    if (!person) return false;
    const [sum] = await this.db.select({ n: sql<number>`coalesce(sum(${allocations.hours}), 0)::float` }).from(allocations).where(and(eq(allocations.userId, userId), eq(allocations.weekStart, weekStart)));
    const planned = round2(sum?.n ?? 0);
    const avail = (await this.availability(orgId, [weekStart], [person])).get(`${userId}|${weekStart.toISOString().slice(0, 10)}`) ?? person.capacity;
    if (planned <= avail + 0.05) return false;
    const admins = await this.db.query.memberships.findMany({ where: and(eq(memberships.organizationId, orgId), inArray(memberships.role, ["owner", "admin"])), columns: { userId: true } });
    let sent = 0;
    for (const a of admins) {
      const claimed = await this.db.insert(reminders).values({ organizationId: orgId, receiverId: a.userId, entityType: "allocation", entityId: userId, kind: "over_alloc", dueAt: weekStart }).onConflictDoNothing().returning({ id: reminders.id });
      if (!claimed.length) continue;
      await this.notifications.notifyDirect({
        orgId,
        receiverId: a.userId,
        entityType: "member",
        entityId: userId,
        verb: "over_allocated",
        title: `${person.name} is over-allocated the week of ${weekStart.toISOString().slice(0, 10)}: ${planned}h planned, ${avail}h available`,
        body: "Rebalance the plan on Resourcing before the week starts. This is the only alert for that week.",
        data: { userId, weekStart: weekStart.toISOString(), planned, available: avail, link: "/resourcing" },
        category: "primary",
      });
      sent++;
    }
    return sent > 0;
  }

  /** Daily: every planned week from now on, in case capacity or leave changed under the plan. */
  async sweepOverAllocation() {
    try {
      const from = startOfWeek(new Date());
      const rows = await this.db.selectDistinct({ orgId: allocations.organizationId, userId: allocations.userId, weekStart: allocations.weekStart }).from(allocations).where(gte(allocations.weekStart, from));
      let n = 0;
      for (const r of rows) if (await this.checkOverAllocation(r.orgId, r.userId, r.weekStart)) n++;
      if (n) this.logger.log(`over-allocation: ${n} new alert(s)`);
    } catch (err) {
      this.logger.warn(`over-allocation sweep failed: ${(err as Error).message}`);
    }
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
