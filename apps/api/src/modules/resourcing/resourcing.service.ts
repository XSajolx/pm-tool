import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { allocations, memberships, projects, timeEntries, users } from "../../db/schema.js";
import { startOfWeek } from "../time/time.service.js";

const WEEK_MS = 7 * 86_400_000;

/**
 * Capacity planning. The board is people × weeks; each cell compares hours
 * *planned* on projects (allocations) with the person's weekly capacity, and
 * shows hours *actually logged* beside it so plan and reality sit together.
 */
@Injectable()
export class ResourcingService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async board(orgId: string, fromWeek: string, weeks = 8) {
    const count = Math.min(Math.max(weeks, 1), 26);
    const start = startOfWeek(new Date(fromWeek));
    const end = new Date(start.getTime() + count * WEEK_MS);
    const weekStarts = Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * WEEK_MS));

    const [people, activeProjects, planned, logged] = await Promise.all([
      this.db
        .select({
          userId: users.id,
          name: users.name,
          role: memberships.role,
          capacity: memberships.weeklyCapacityHours,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.organizationId, orgId)),
      this.db
        .select({ id: projects.id, name: projects.name, color: projects.color })
        .from(projects)
        .where(and(eq(projects.organizationId, orgId), isNull(projects.archivedAt))),
      this.db
        .select()
        .from(allocations)
        .where(
          and(
            eq(allocations.organizationId, orgId),
            gte(allocations.weekStart, start),
            lt(allocations.weekStart, end),
          ),
        ),
      // Logged hours bucketed to the Monday of their week, per person. Returned
      // as a plain YYYY-MM-DD string so it keys identically to `weekStarts`
      // below — parsing a zone-less timestamp with `new Date` would shift it
      // into the server's local zone and miss every match.
      this.db
        .select({
          userId: timeEntries.userId,
          weekStart: sql<string>`to_char(date_trunc('week', ${timeEntries.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          seconds: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int`,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.organizationId, orgId),
            gte(timeEntries.startedAt, start),
            lt(timeEntries.startedAt, end),
          ),
        )
        .groupBy(timeEntries.userId, sql`date_trunc('week', ${timeEntries.startedAt} at time zone 'UTC')`),
    ]);

    const key = (userId: string, week: Date) => `${userId}|${week.toISOString().slice(0, 10)}`;
    const plannedByCell = new Map<string, { total: number; byProject: Record<string, number> }>();
    for (const a of planned) {
      const k = key(a.userId, a.weekStart);
      const cell = plannedByCell.get(k) ?? { total: 0, byProject: {} };
      cell.total += a.hours;
      cell.byProject[a.projectId] = (cell.byProject[a.projectId] ?? 0) + a.hours;
      plannedByCell.set(k, cell);
    }
    const loggedByCell = new Map<string, number>();
    for (const l of logged) {
      loggedByCell.set(`${l.userId}|${l.weekStart}`, l.seconds / 3600);
    }

    return {
      weeks: weekStarts.map((w) => w.toISOString()),
      projects: activeProjects,
      members: people.map((p) => ({
        userId: p.userId,
        name: p.name,
        role: p.role,
        capacity: p.capacity,
        cells: weekStarts.map((w) => {
          const plan = plannedByCell.get(key(p.userId, w));
          const allocated = round2(plan?.total ?? 0);
          return {
            weekStart: w.toISOString(),
            allocated,
            logged: round2(loggedByCell.get(key(p.userId, w)) ?? 0),
            utilization: p.capacity ? round2(allocated / p.capacity) : 0,
            byProject: plan?.byProject ?? {},
          };
        }),
      })),
    };
  }

  /** Upsert one (person, project, week). Zero hours removes the row. */
  async setAllocation(
    orgId: string,
    actorId: string,
    dto: { userId: string; projectId: string; weekStart: string; hours: number; note?: string },
  ) {
    const [member, project] = await Promise.all([
      this.db.query.memberships.findFirst({
        where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, dto.userId)),
      }),
      this.db.query.projects.findFirst({
        where: and(eq(projects.id, dto.projectId), eq(projects.organizationId, orgId)),
      }),
    ]);
    if (!member) throw new BadRequestException("That person is not a member of this organization");
    if (!project) throw new BadRequestException("Project not found in this organization");

    const weekStart = startOfWeek(new Date(dto.weekStart));

    if (dto.hours <= 0) {
      await this.db
        .delete(allocations)
        .where(
          and(
            eq(allocations.userId, dto.userId),
            eq(allocations.projectId, dto.projectId),
            eq(allocations.weekStart, weekStart),
          ),
        );
      return { ok: true };
    }

    await this.db
      .insert(allocations)
      .values({
        organizationId: orgId,
        userId: dto.userId,
        projectId: dto.projectId,
        weekStart,
        hours: dto.hours,
        note: dto.note ?? null,
        createdById: actorId,
      })
      .onConflictDoUpdate({
        target: [allocations.userId, allocations.projectId, allocations.weekStart],
        set: { hours: dto.hours, note: dto.note ?? null, updatedAt: new Date() },
      });
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
  async allocationsFor(orgId: string, userIds: string[], fromWeek: string, weeks = 8) {
    if (!userIds.length) return [];
    const start = startOfWeek(new Date(fromWeek));
    const end = new Date(start.getTime() + Math.min(Math.max(weeks, 1), 26) * WEEK_MS);
    return this.db
      .select()
      .from(allocations)
      .where(
        and(
          eq(allocations.organizationId, orgId),
          inArray(allocations.userId, userIds),
          gte(allocations.weekStart, start),
          lt(allocations.weekStart, end),
        ),
      );
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
