import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { memberships, organizations, reminders, timeEntries, timesheetSubmissions } from "../../db/schema.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { accessEnded } from "../auth/auth.service.js";
import { startOfWeek } from "./time.service.js";
import { WorkCalendarService } from "./work-calendar.service.js";

export interface ReminderSlot {
  weekday: number;
  hour: number;
  /** Which week the nudge is about: Friday afternoon -> this week; Monday morning -> last week. */
  week: "current" | "previous";
}
export const DEFAULT_TIMESHEET_REMINDERS: ReminderSlot[] = [
  { weekday: 5, hour: 16, week: "current" },
  { weekday: 1, hour: 9, week: "previous" },
];
const DAY_MS = 86_400_000;

/**
 * Row 94: a sweep every ten minutes checks each workspace's schedule. When a
 * slot's weekday + hour has arrived it nudges only the people whose target
 * week is incomplete - fewer hours than their weekly capacity, or not yet
 * submitted. The `reminders` ledger keeps it to one nudge per person per
 * slot per week; people who've left are skipped.
 */
@Injectable()
export class TimesheetRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimesheetRemindersService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly notifications: NotificationsService,
    private readonly calendar: WorkCalendarService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), 10 * 60 * 1000);
    setTimeout(() => void this.sweep(), 15_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async schedule(orgId: string) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { timesheetReminders: true } });
    return org?.timesheetReminders ?? DEFAULT_TIMESHEET_REMINDERS;
  }

  async setSchedule(orgId: string, slots: ReminderSlot[]) {
    await this.db.update(organizations).set({ timesheetReminders: slots, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    return slots;
  }

  /** Run every slot that is due right now, across all workspaces. `force` runs one slot for one org regardless of the clock. */
  async sweep(force?: { orgId: string; slot: ReminderSlot }) {
    try {
      const now = new Date();
      const orgs = force ? [{ id: force.orgId, timesheetReminders: [force.slot] }] : await this.db.select({ id: organizations.id, timesheetReminders: organizations.timesheetReminders }).from(organizations);
      let sent = 0;
      for (const org of orgs) {
        const slots = org.timesheetReminders ?? DEFAULT_TIMESHEET_REMINDERS;
        for (const slot of slots) {
          const due = force || (now.getDay() === slot.weekday && now.getHours() === slot.hour);
          if (!due) continue;
          sent += await this.runSlot(org.id, slot, now);
        }
      }
      if (sent) this.logger.log(`sent ${sent} timesheet reminder(s)`);
      return { sent };
    } catch (err) {
      this.logger.warn(`timesheet reminder sweep failed: ${(err as Error).message}`);
      return { sent: 0 };
    }
  }

  /** Who in this org is behind for the slot's target week? */
  async incomplete(orgId: string, slot: ReminderSlot, now = new Date()) {
    const thisWeek = startOfWeek(now);
    const weekStart = slot.week === "previous" ? new Date(thisWeek.getTime() - 7 * DAY_MS) : thisWeek;
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
    const members = await this.db.query.memberships.findMany({ where: eq(memberships.organizationId, orgId) });
    const active = members.filter((m) => !accessEnded(m) && m.role !== "guest");
    if (!active.length) return { weekStart, people: [] as { userId: string; hours: number; expected: number; submitted: boolean }[] };
    const ids = active.map((m) => m.userId);
    const exp = await this.calendar.expectedFor(orgId, weekStart, ids);
    const [hoursRows, subs] = await Promise.all([
      this.db
        .select({ userId: timeEntries.userId, seconds: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int` })
        .from(timeEntries)
        .where(and(eq(timeEntries.organizationId, orgId), inArray(timeEntries.userId, ids), gte(timeEntries.startedAt, weekStart), lt(timeEntries.startedAt, weekEnd), isNull(timeEntries.archivedAt)))
        .groupBy(timeEntries.userId),
      this.db.query.timesheetSubmissions.findMany({ where: and(eq(timesheetSubmissions.organizationId, orgId), eq(timesheetSubmissions.weekStart, weekStart), inArray(timesheetSubmissions.userId, ids)), columns: { userId: true, status: true } }),
    ]);
    const hoursBy = new Map(hoursRows.map((h) => [h.userId, h.seconds / 3600]));
    const subBy = new Map(subs.map((s) => [s.userId, s.status]));
    const people = active
      .map((m) => ({ userId: m.userId, hours: Math.round((hoursBy.get(m.userId) ?? 0) * 10) / 10, expected: exp.get(m.userId)?.expected ?? m.weeklyCapacityHours, submitted: ["submitted", "approved"].includes(subBy.get(m.userId) ?? "") }))
      .filter((p) => p.hours < p.expected || !p.submitted);
    return { weekStart, people };
  }

  private async runSlot(orgId: string, slot: ReminderSlot, now: Date) {
    const { weekStart, people } = await this.incomplete(orgId, slot, now);
    // The slot's own timestamp this week is the dedupe key.
    const slotAt = new Date(now);
    slotAt.setHours(slot.hour, 0, 0, 0);
    slotAt.setDate(now.getDate() - now.getDay() + slot.weekday);
    let sent = 0;
    for (const p of people) {
      const claimed = await this.db
        .insert(reminders)
        .values({ organizationId: orgId, receiverId: p.userId, entityType: "timesheet_week", entityId: p.userId, kind: `slot_${slot.weekday}_${slot.hour}`.slice(0, 24), dueAt: slotAt })
        .onConflictDoNothing()
        .returning({ id: reminders.id });
      if (!claimed.length) continue;
      const missing = Math.max(0, Math.round((p.expected - p.hours) * 10) / 10);
      await this.notifications.notifyDirect({
        orgId,
        receiverId: p.userId,
        entityType: "timesheet",
        entityId: p.userId,
        verb: "timesheet_reminder",
        title: slot.week === "previous" ? `Last week's timesheet isn't finished` : `Your timesheet for this week isn't finished`,
        body: `${p.hours}h of ${p.expected}h logged for the week of ${weekStart.toLocaleDateString()}${missing ? ` (${missing}h to go)` : ""}${p.submitted ? "" : " - not submitted yet"}`,
        data: { weekStart: weekStart.toISOString(), link: "/timesheets" },
        category: "other",
      });
      sent++;
    }
    return sent;
  }
}
