import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { leaveRequests, memberships, projects, timeEntries, users } from "../../db/schema.js";
import { NotificationsService, pendingApproval } from "../notifications/notifications.service.js";
import { TimeCodesService } from "./time-codes.service.js";
import type { Actor } from "./time.service.js";

const DAY_MS = 86_400_000;
export type LeaveKind = "vacation" | "sick" | "personal" | "other";

/** Weekdays (Mon-Fri) between two dates inclusive. */
function weekdaysBetween(start: Date, end: Date) {
  const out: Date[] = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + DAY_MS)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(d));
  }
  return out;
}

/**
 * Row 98: request days off, a project manager approves from the inbox card
 * (or the leave list), and approved leave becomes PTO hours on the timesheet
 * and a badge on the team calendar - so capacity is right without anyone
 * typing hours for a holiday.
 */
@Injectable()
export class LeaveService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly notifications: NotificationsService,
    private readonly codes: TimeCodesService,
  ) {}

  onModuleInit() {
    this.notifications.registerApproval("leave", (d) => this.decide(d.orgId, { userId: d.userId, role: d.role as Actor["role"] }, d.entityId, d.approve, d.note));
  }

  async list(orgId: string, actor: Actor, opts: { from?: string; to?: string; all?: boolean }) {
    const admin = actor.role === "owner" || actor.role === "admin";
    const where = [eq(leaveRequests.organizationId, orgId)];
    if (!(opts.all && admin)) where.push(eq(leaveRequests.userId, actor.userId));
    if (opts.from) where.push(gte(leaveRequests.endDate, new Date(opts.from)));
    if (opts.to) where.push(lte(leaveRequests.startDate, new Date(opts.to)));
    const rows = await this.db.query.leaveRequests.findMany({
      where: and(...where),
      with: { user: { columns: { id: true, name: true } }, decidedBy: { columns: { id: true, name: true } } },
      orderBy: [desc(leaveRequests.startDate)],
      limit: 300,
    });
    return rows.map((r) => ({ ...r, days: weekdaysBetween(r.startDate, r.endDate).length }));
  }

  async create(orgId: string, actor: Actor, dto: { kind: LeaveKind; startDate: string; endDate: string; note?: string; hoursPerDay?: number }) {
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (!(start <= end)) throw new BadRequestException("The end date is before the start date");
    const days = weekdaysBetween(start, end);
    if (!days.length) throw new BadRequestException("Pick at least one weekday");
    const membership = await this.db.query.memberships.findFirst({ where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, actor.userId)), columns: { weeklyCapacityHours: true } });
    const hoursPerDay = dto.hoursPerDay ?? Math.round(((membership?.weeklyCapacityHours ?? 40) / 5) * 10) / 10;
    // Approver: an owner / project manager who isn't the requester.
    const admins = await this.db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.organizationId, orgId), inArray(memberships.role, ["owner", "admin"])));
    const approver = admins.find((a) => a.userId !== actor.userId)?.userId ?? admins[0]?.userId ?? null;
    const [row] = await this.db
      .insert(leaveRequests)
      .values({ organizationId: orgId, userId: actor.userId, kind: dto.kind, startDate: start, endDate: end, hoursPerDay, note: dto.note?.trim() || null, approverId: approver })
      .returning();
    const [who] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));
    if (approver && approver !== actor.userId) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId: approver,
        actorId: actor.userId,
        entityType: "leave",
        entityId: row!.id,
        verb: "leave_requested",
        title: `Time off: ${who?.name ?? "Someone"} - ${days.length} day${days.length === 1 ? "" : "s"} ${dto.kind}`,
        body: `${start.toLocaleDateString()} → ${end.toLocaleDateString()}${dto.note ? ` · ${dto.note.trim()}` : ""}`,
        data: { leaveId: row!.id, approval: pendingApproval("leave") },
      });
    }
    return { ...row!, days: days.length };
  }

  async cancel(orgId: string, actor: Actor, id: string) {
    const row = await this.db.query.leaveRequests.findFirst({ where: and(eq(leaveRequests.id, id), eq(leaveRequests.organizationId, orgId)) });
    if (!row) throw new NotFoundException("Request not found");
    const admin = actor.role === "owner" || actor.role === "admin";
    if (row.userId !== actor.userId && !admin) throw new ForbiddenException("Not your request");
    if (row.status === "approved") await this.removePtoEntries(orgId, row);
    await this.db.update(leaveRequests).set({ status: "cancelled" }).where(eq(leaveRequests.id, id));
    await this.notifications.resolveApproval("leave", id, "rejected", "Cancelled by requester", actor.userId);
    return { id, status: "cancelled" };
  }

  /** Approve / reject. Approving writes PTO hours into the timesheet for each weekday. */
  async decide(orgId: string, actor: Actor, id: string, approve: boolean, note?: string) {
    const row = await this.db.query.leaveRequests.findFirst({ where: and(eq(leaveRequests.id, id), eq(leaveRequests.organizationId, orgId)) });
    if (!row) throw new NotFoundException("Request not found");
    if (row.status !== "pending") throw new BadRequestException("This request was already decided");
    const admin = actor.role === "owner" || actor.role === "admin";
    if (!admin && row.approverId !== actor.userId) throw new ForbiddenException("Only a project manager can decide time off");
    const now = new Date();
    await this.db
      .update(leaveRequests)
      .set({ status: approve ? "approved" : "rejected", decidedById: actor.userId, decidedAt: now, decisionNote: note?.trim() || null })
      .where(eq(leaveRequests.id, id));
    if (approve) await this.writePtoEntries(orgId, row);
    await this.notifications.resolveApproval("leave", id, approve ? "approved" : "rejected", note, actor.userId);
    if (row.userId !== actor.userId) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId: row.userId,
        actorId: actor.userId,
        entityType: "leave",
        entityId: id,
        verb: approve ? "leave_approved" : "leave_rejected",
        title: `Time off ${approve ? "approved" : "declined"}: ${row.startDate.toLocaleDateString()} → ${row.endDate.toLocaleDateString()}`,
        body: note?.trim() || (approve ? "Enjoy - it's on your timesheet and the team calendar." : "Talk to your project manager about alternatives."),
        data: { leaveId: id },
      });
    }
    return { id, status: approve ? "approved" : "rejected" };
  }

  /** The PTO time code (created if the workspace doesn't have one yet). */
  private async ptoProjectId(orgId: string) {
    await this.codes.ensureDefaults(orgId);
    const code = await this.db.query.projects.findFirst({ where: and(eq(projects.organizationId, orgId), eq(projects.kind, "internal"), eq(projects.name, "PTO")), columns: { id: true } });
    if (code) return code.id;
    const created = await this.codes.create(orgId, "PTO", "#10b981");
    return created.id;
  }

  private async writePtoEntries(orgId: string, row: typeof leaveRequests.$inferSelect) {
    const projectId = await this.ptoProjectId(orgId);
    const seconds = Math.round(row.hoursPerDay * 3600);
    for (const day of weekdaysBetween(row.startDate, row.endDate)) {
      const startedAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9));
      await this.db.insert(timeEntries).values({
        organizationId: orgId,
        userId: row.userId,
        projectId,
        description: `${row.kind} leave`,
        startedAt,
        endedAt: new Date(startedAt.getTime() + seconds * 1000),
        durationSeconds: seconds,
        billable: false,
        source: "leave",
      });
    }
  }

  private async removePtoEntries(orgId: string, row: typeof leaveRequests.$inferSelect) {
    const projectId = await this.ptoProjectId(orgId);
    await this.db
      .delete(timeEntries)
      .where(and(eq(timeEntries.organizationId, orgId), eq(timeEntries.userId, row.userId), eq(timeEntries.projectId, projectId), eq(timeEntries.source, "leave"), gte(timeEntries.startedAt, row.startDate), lte(timeEntries.startedAt, new Date(row.endDate.getTime() + DAY_MS))));
  }

  /** Approved (and pending) leave per person in a window - for the team calendar. */
  async calendar(orgId: string, from: string, to: string) {
    const rows = await this.db.query.leaveRequests.findMany({
      where: and(eq(leaveRequests.organizationId, orgId), inArray(leaveRequests.status, ["approved", "pending"]), gte(leaveRequests.endDate, new Date(from)), lte(leaveRequests.startDate, new Date(to))),
      with: { user: { columns: { id: true, name: true } } },
    });
    return rows.map((r) => ({ id: r.id, userId: r.userId, name: r.user.name, kind: r.kind, status: r.status, startDate: r.startDate, endDate: r.endDate, days: weekdaysBetween(r.startDate, r.endDate).length }));
  }
}
