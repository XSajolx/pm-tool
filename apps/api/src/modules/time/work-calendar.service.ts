import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { holidays, memberships, organizations } from "../../db/schema.js";
import { accessEnded } from "../auth/auth.service.js";

const DAY_MS = 86_400_000;
export type EmploymentType = "full_time" | "part_time" | "contractor";

/**
 * Row 110: the numbers timesheets and workload compare against. A person's
 * week is their capacity spread over their working days; every company holiday
 * or closure that lands on one of those days takes a day's worth off.
 */
@Injectable()
export class WorkCalendarService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async settings(orgId: string) {
    const [org, days, members] = await Promise.all([
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { standardWeeklyHours: true, workingDays: true } }),
      this.db.query.holidays.findMany({ where: eq(holidays.organizationId, orgId), orderBy: [asc(holidays.date)] }),
      this.db.query.memberships.findMany({ where: eq(memberships.organizationId, orgId), with: { user: { columns: { id: true, name: true, avatarUrl: true } } } }),
    ]);
    return {
      standardWeeklyHours: org?.standardWeeklyHours ?? 40,
      workingDays: org?.workingDays ?? [1, 2, 3, 4, 5],
      holidays: days.map((h) => ({ id: h.id, date: h.date.toISOString(), name: h.name, kind: h.kind as "holiday" | "closure" })),
      members: members
        .filter((m) => !accessEnded(m) && m.role !== "guest")
        .map((m) => ({
          userId: m.userId,
          name: m.user.name,
          avatarUrl: m.user.avatarUrl,
          role: m.role,
          weeklyCapacityHours: m.weeklyCapacityHours,
          workingDays: m.workingDays,
          employmentType: (m.employmentType as EmploymentType) ?? "full_time",
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async updateSettings(orgId: string, dto: { standardWeeklyHours?: number; workingDays?: number[] }) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.standardWeeklyHours !== undefined) patch.standardWeeklyHours = dto.standardWeeklyHours;
    if (dto.workingDays !== undefined) {
      const days = [...new Set(dto.workingDays)].filter((d) => d >= 0 && d <= 6).sort();
      if (!days.length) throw new BadRequestException("Keep at least one working day");
      patch.workingDays = days;
    }
    await this.db.update(organizations).set(patch).where(eq(organizations.id, orgId));
    return this.settings(orgId);
  }

  async addHoliday(orgId: string, dto: { date: string; name: string; kind?: "holiday" | "closure" }) {
    const day = new Date(dto.date);
    if (Number.isNaN(day.getTime())) throw new BadRequestException("Bad date");
    const date = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    await this.db
      .insert(holidays)
      .values({ organizationId: orgId, date, name: dto.name.trim(), kind: dto.kind ?? "holiday" })
      .onConflictDoUpdate({ target: [holidays.organizationId, holidays.date], set: { name: dto.name.trim(), kind: dto.kind ?? "holiday" } });
    return this.settings(orgId);
  }

  async removeHoliday(orgId: string, id: string) {
    const rows = await this.db.delete(holidays).where(and(eq(holidays.id, id), eq(holidays.organizationId, orgId))).returning({ id: holidays.id });
    if (!rows.length) throw new NotFoundException("Holiday not found");
    return this.settings(orgId);
  }

  async updateMember(orgId: string, userId: string, dto: { weeklyCapacityHours?: number; workingDays?: number[] | null; employmentType?: EmploymentType }) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.weeklyCapacityHours !== undefined) patch.weeklyCapacityHours = dto.weeklyCapacityHours;
    if (dto.workingDays !== undefined) {
      if (dto.workingDays === null) patch.workingDays = null;
      else {
        const days = [...new Set(dto.workingDays)].filter((d) => d >= 0 && d <= 6).sort();
        if (!days.length) throw new BadRequestException("Keep at least one working day");
        patch.workingDays = days;
      }
    }
    if (dto.employmentType !== undefined) patch.employmentType = dto.employmentType;
    const rows = await this.db
      .update(memberships)
      .set(patch)
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
    if (!rows.length) throw new NotFoundException("Member not found");
    return this.settings(orgId);
  }

  /**
   * Expected hours per person for the week starting `weekStart` (Mon 00:00 UTC),
   * after company holidays. Also returns which holidays fell in the week.
   */
  async expectedFor(orgId: string, weekStart: Date, userIds: string[]) {
    const out = new Map<string, { expected: number; holidays: { date: string; name: string; kind: string }[]; workingDays: number[] }>();
    if (!userIds.length) return out;
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
    const [org, days, members] = await Promise.all([
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { workingDays: true } }),
      this.db.query.holidays.findMany({ where: and(eq(holidays.organizationId, orgId), gte(holidays.date, weekStart), lt(holidays.date, weekEnd)) }),
      this.db.query.memberships.findMany({ where: and(eq(memberships.organizationId, orgId), inArray(memberships.userId, userIds)), columns: { userId: true, weeklyCapacityHours: true, workingDays: true } }),
    ]);
    const orgDays = org?.workingDays ?? [1, 2, 3, 4, 5];
    for (const m of members) {
      const working = m.workingDays?.length ? m.workingDays : orgDays;
      const perDay = working.length ? m.weeklyCapacityHours / working.length : 0;
      const off = days.filter((h) => working.includes(h.date.getUTCDay()));
      const expected = Math.max(0, Math.round((m.weeklyCapacityHours - off.length * perDay) * 10) / 10);
      out.set(m.userId, { expected, holidays: days.map((h) => ({ date: h.date.toISOString(), name: h.name, kind: h.kind })), workingDays: working });
    }
    return out;
  }
}
