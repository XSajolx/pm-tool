import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { milestones, projects, reminders, taskAssignees, tasks } from "../../db/schema.js";
import { NotificationsService } from "./notifications.service.js";

/** How far ahead "due soon" looks. */
const DUE_SOON_MS = 24 * 60 * 60 * 1000;
/** Don't nag about things that went overdue ages ago (e.g. old seed data). */
const OVERDUE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

type Kind = "due_soon" | "overdue";

/**
 * Row 72: due-date reminders for tasks and milestones. A sweep runs every few
 * minutes and sends, per assignee (tasks) or project lead (milestones):
 *   - "due_soon"  once, when the due date is within the next 24h
 *   - "overdue"   once, when the due date has passed and the thing isn't done
 * The `reminders` table is the ledger: one row per (receiver, thing, kind,
 * due date), so nothing repeats daily and a moved date earns a fresh nudge.
 * Assignment notifications themselves come from TasksService ("assigned").
 */
@Injectable()
export class RemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RemindersService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), 5 * 60 * 1000);
    setTimeout(() => void this.sweep(), 8000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run both sweeps; returns how many reminders went out (for the manual trigger). */
  async sweep() {
    let sent = 0;
    try {
      sent += await this.sweepTasks();
      sent += await this.sweepMilestones();
      if (sent) this.logger.log(`sent ${sent} due-date reminder(s)`);
    } catch (err) {
      this.logger.warn(`reminder sweep failed: ${(err as Error).message}`);
    }
    return { sent };
  }

  private async sweepTasks() {
    const now = new Date();
    const soon = new Date(now.getTime() + DUE_SOON_MS);
    const floor = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);

    const open = and(isNull(tasks.completedAt), isNull(tasks.archivedAt));
    const [dueSoon, overdue] = await Promise.all([
      this.db.select().from(tasks).where(and(open, gte(tasks.dueDate, now), lte(tasks.dueDate, soon))).limit(500),
      this.db.select().from(tasks).where(and(open, lt(tasks.dueDate, now), gte(tasks.dueDate, floor))).limit(500),
    ]);
    const all = [...dueSoon.map((t) => ({ t, kind: "due_soon" as Kind })), ...overdue.map((t) => ({ t, kind: "overdue" as Kind }))];
    if (!all.length) return 0;

    const assignees = await this.db
      .select({ taskId: taskAssignees.taskId, userId: taskAssignees.userId })
      .from(taskAssignees)
      .where(inArray(taskAssignees.taskId, all.map((x) => x.t.id)));
    const byTask = new Map<string, string[]>();
    for (const a of assignees) byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a.userId]);

    let sent = 0;
    for (const { t, kind } of all) {
      const due = t.dueDate!;
      for (const userId of byTask.get(t.id) ?? []) {
        const fresh = await this.claim(t.organizationId, userId, "task", t.id, kind, due);
        if (!fresh) continue;
        await this.notifications.notifyDirect({
          orgId: t.organizationId,
          receiverId: userId,
          entityType: "task",
          entityId: t.id,
          verb: kind,
          title: kind === "due_soon" ? `Due ${describeSoon(due, now)}: ${t.title}` : `Overdue: ${t.title}`,
          body: kind === "due_soon" ? `Due ${due.toLocaleString()}` : `Was due ${due.toLocaleDateString()}`,
          data: { taskId: t.id, dueAt: due.toISOString(), kind },
        });
        sent++;
      }
    }
    return sent;
  }

  private async sweepMilestones() {
    const now = new Date();
    const soon = new Date(now.getTime() + DUE_SOON_MS);
    const floor = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);

    const open = and(isNull(milestones.reachedAt), isNull(milestones.archivedAt));
    const pick = (where: ReturnType<typeof and>) =>
      this.db
        .select({ m: milestones, leadId: projects.leadId, projectName: projects.name })
        .from(milestones)
        .innerJoin(projects, eq(projects.id, milestones.projectId))
        .where(where)
        .limit(500);
    const [dueSoon, overdue] = await Promise.all([
      pick(and(open, gte(milestones.targetDate, now), lte(milestones.targetDate, soon))),
      pick(and(open, lt(milestones.targetDate, now), gte(milestones.targetDate, floor))),
    ]);

    let sent = 0;
    const all = [...dueSoon.map((x) => ({ ...x, kind: "due_soon" as Kind })), ...overdue.map((x) => ({ ...x, kind: "overdue" as Kind }))];
    for (const { m, leadId, projectName, kind } of all) {
      if (!leadId) continue; // nobody owns the project yet -> nobody to nudge
      const due = m.targetDate!;
      const fresh = await this.claim(m.organizationId, leadId, "milestone", m.id, kind, due);
      if (!fresh) continue;
      await this.notifications.notifyDirect({
        orgId: m.organizationId,
        receiverId: leadId,
        entityType: "milestone",
        entityId: m.id,
        verb: kind,
        title: kind === "due_soon" ? `Milestone due ${describeSoon(due, now)}: ${m.name}` : `Milestone overdue: ${m.name}`,
        body: `${projectName} - target ${due.toLocaleDateString()}`,
        data: { projectId: m.projectId, milestoneId: m.id, dueAt: due.toISOString(), kind },
      });
      sent++;
    }
    return sent;
  }

  /** Insert the ledger row; false when this exact reminder already went out. */
  private async claim(orgId: string, receiverId: string, entityType: string, entityId: string, kind: Kind, dueAt: Date) {
    const rows = await this.db
      .insert(reminders)
      .values({ organizationId: orgId, receiverId, entityType, entityId, kind, dueAt })
      .onConflictDoNothing()
      .returning({ id: reminders.id });
    return rows.length > 0;
  }
}

function describeSoon(due: Date, now: Date) {
  const sameDay = due.toDateString() === now.toDateString();
  return sameDay ? "today" : "tomorrow";
}
