import { Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { memberships, projectStages, projects, reminders, timeEntries } from "../../db/schema.js";
import { RatesService } from "../finance/rates.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const THRESHOLDS = [75, 90, 100] as const;

/**
 * Rows 150-152: hour and $ budgets per stage, how much of each is burnt
 * (hours from time entries on the stage; cost = those hours × each person's
 * cost rate on the day) beside the hand-set % complete, and one inbox alert
 * per stage per threshold (75 / 90 / 100 % of hours or cost) to the project
 * lead and admins — the reminders ledger makes each one fire exactly once.
 */
@Injectable()
export class StageBudgetsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StageBudgetsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly rates: RatesService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    setTimeout(() => void this.sweep(), 50_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Burn for every stage of a project. Cost figures are only meaningful to owners/admins; the controller strips them for others. */
  async burn(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { id: true, name: true, currency: true, leadId: true, budgetHours: true, budgetAmount: true } });
    if (!project) throw new NotFoundException("Project not found");
    const stages = await this.db.query.projectStages.findMany({ where: and(eq(projectStages.projectId, projectId), isNull(projectStages.archivedAt)), orderBy: [asc(projectStages.position), asc(projectStages.createdAt)] });
    if (!stages.length) return { project: { id: project.id, name: project.name, currency: project.currency }, stages: [], totals: { budgetHours: 0, usedHours: 0, budgetAmount: 0, usedCost: 0 } };
    const entries = await this.db.select({ stageId: timeEntries.stageId, userId: timeEntries.userId, startedAt: timeEntries.startedAt, seconds: timeEntries.durationSeconds }).from(timeEntries).where(and(eq(timeEntries.projectId, projectId), inArray(timeEntries.stageId, stages.map((s) => s.id))));
    const resolve = await this.rates.resolver(orgId, [projectId]);
    const rows = stages.map((s, i) => {
      const mine = entries.filter((e) => e.stageId === s.id);
      const seconds = mine.reduce((a, e) => a + e.seconds, 0);
      const usedCost = round2(mine.reduce((a, e) => a + (e.seconds / 3600) * resolve(e.userId, projectId, e.startedAt).costRate, 0));
      const usedHours = round2(seconds / 3600);
      const hoursPct = s.budgetHours ? Math.round((usedHours / s.budgetHours) * 100) : null;
      const costPct = s.budgetAmount ? Math.round((usedCost / s.budgetAmount) * 100) : null;
      const burn = Math.max(hoursPct ?? 0, costPct ?? 0);
      const hasBudget = hoursPct != null || costPct != null;
      return {
        id: s.id,
        index: i + 1,
        name: s.name,
        status: s.status,
        progressPct: s.progressPct,
        feeAmount: s.feeAmount,
        budgetHours: s.budgetHours,
        budgetAmount: s.budgetAmount,
        usedHours,
        usedCost,
        hoursPct,
        costPct,
        remainingHours: s.budgetHours != null ? round2(s.budgetHours - usedHours) : null,
        remainingAmount: s.budgetAmount != null ? round2(s.budgetAmount - usedCost) : null,
        /** Burn well ahead of progress = trouble; hand-set % is the reference. */
        atRisk: hasBudget && burn - s.progressPct >= 25 && burn >= 50,
        overBudget: (hoursPct ?? 0) > 100 || (costPct ?? 0) > 100,
        /** Which alerts have fired (hours_75 …), for the UI. */
        alerts: [] as string[],
      };
    });
    const fired = await this.db.select({ entityId: reminders.entityId, kind: reminders.kind }).from(reminders).where(and(eq(reminders.organizationId, orgId), eq(reminders.entityType, "stage"), inArray(reminders.entityId, stages.map((s) => s.id))));
    for (const r of rows) r.alerts = [...new Set(fired.filter((f) => f.entityId === r.id).map((f) => f.kind))];
    return {
      project: { id: project.id, name: project.name, currency: project.currency },
      stages: rows,
      totals: {
        budgetHours: round2(rows.reduce((a, r) => a + (r.budgetHours ?? 0), 0)),
        usedHours: round2(rows.reduce((a, r) => a + r.usedHours, 0)),
        budgetAmount: round2(rows.reduce((a, r) => a + (r.budgetAmount ?? 0), 0)),
        usedCost: round2(rows.reduce((a, r) => a + r.usedCost, 0)),
      },
    };
  }

  /** Row 152: fire any newly crossed threshold for one project's stages. Returns how many alerts went out. */
  async check(orgId: string, projectId: string) {
    const b = await this.burn(orgId, projectId);
    const project = await this.db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { leadId: true, name: true } });
    let sent = 0;
    for (const s of b.stages) {
      for (const [metric, pct, used, budget, unit] of [
        ["hours", s.hoursPct, s.usedHours, s.budgetHours, "h"],
        ["cost", s.costPct, s.usedCost, s.budgetAmount, b.project.currency + " "],
      ] as const) {
        if (pct == null) continue;
        for (const t of THRESHOLDS) {
          if (pct < t) continue;
          const kind = `stage_${metric}_${t}`;
          if (s.alerts.includes(kind)) continue;
          const receivers = new Set<string>();
          if (project?.leadId) receivers.add(project.leadId);
          for (const m of await this.db.query.memberships.findMany({ where: and(eq(memberships.organizationId, orgId), inArray(memberships.role, ["owner", "admin"])), columns: { userId: true } })) receivers.add(m.userId);
          let fired = false;
          for (const receiver of receivers) {
            const claimed = await this.db.insert(reminders).values({ organizationId: orgId, receiverId: receiver, entityType: "stage", entityId: s.id, kind, dueAt: new Date(0) }).onConflictDoNothing().returning({ id: reminders.id });
            if (!claimed.length) continue;
            fired = true;
            const fmt = (n: number) => (metric === "hours" ? `${n}h` : `${unit}${n.toFixed(2)}`);
            await this.notifications.notifyDirect({
              orgId,
              receiverId: receiver,
              entityType: "project",
              entityId: projectId,
              verb: t >= 100 ? "stage_budget_exceeded" : "stage_budget_warning",
              title: `${b.project.name} · ${s.name}: ${pct}% of the ${metric} budget used (${fmt(used)} of ${fmt(budget ?? 0)})${s.progressPct ? ` · ${s.progressPct}% complete` : ""}`,
              body: t >= 100 ? "The stage has passed its budget. Re-scope, re-budget or agree a change with the client." : `Passed the ${t}% mark. This is the only alert for this threshold.`,
              data: { projectId, stageId: s.id, metric, threshold: t, pct, link: `/projects/${projectId}` },
              category: "primary",
            });
          }
          if (fired) sent++;
        }
      }
    }
    return sent;
  }

  /** Hourly, every project with any stage budget set. */
  async sweep() {
    try {
      const rows = await this.db.selectDistinct({ orgId: projectStages.organizationId, projectId: projectStages.projectId }).from(projectStages).innerJoin(projects, eq(projects.id, projectStages.projectId)).where(and(isNull(projectStages.archivedAt), isNull(projects.archivedAt), eq(projects.status, "active")));
      let n = 0;
      for (const r of rows) n += await this.check(r.orgId, r.projectId).catch(() => 0);
      if (n) this.logger.log(`stage budgets: ${n} alert(s)`);
    } catch (err) {
      this.logger.warn(`stage budget sweep failed: ${(err as Error).message}`);
    }
  }
}
