import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { activityLog, automationRules, automationRuns, companies, dealStages, deals, expenses, invoices, lists, memberships, milestones, projectStages, projects, statuses, taskAssignees, tasks, users, type AutomationAction, type AutomationTrigger, type AutomationTriggerType } from "../../db/schema.js";
import { ActivityService, type ActivityRow } from "../activity/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { TasksService } from "../tasks/tasks.service.js";
import { backgroundJobsEnabled, registerJob } from "../../common/jobs.js";

export const TRIGGERS: { type: AutomationTriggerType; label: string; hasName?: string }[] = [
  { type: "task_created", label: "A task is created" },
  { type: "task_status_changed", label: "A task moves to a status", hasName: "status" },
  { type: "task_completed", label: "A task is completed" },
  { type: "expense_approved", label: "An expense is approved" },
  { type: "invoice_overdue", label: "An invoice becomes overdue" },
  { type: "invoice_paid", label: "An invoice is paid in full" },
  { type: "stage_completed", label: "A project stage is completed", hasName: "stage" },
  { type: "milestone_reached", label: "A milestone is reached" },
  { type: "deal_stage_changed", label: "A deal moves to a stage", hasName: "deal stage" },
];

/** Everything an action might need to know about the record that fired the rule. */
interface Ctx {
  orgId: string;
  entityType: string;
  entityId: string;
  label: string;
  projectId: string | null;
  projectName: string | null;
  leadId: string | null;
  taskId: string | null;
  listId: string | null;
  spaceId: string | null;
  assigneeIds: string[];
  statusName: string | null;
  actorId: string | null;
  actorName: string | null;
  link: string;
}

export interface RuleDto {
  name?: string;
  enabled?: boolean;
  ownerId?: string;
  projectId?: string | null;
  trigger?: AutomationTrigger;
  actions?: AutomationAction[];
}

/**
 * Rows 153-155: "when X then Y". Rules listen to the activity log — the one
 * place every mutation already passes through — so a trigger is just a
 * pattern over an activity row. Actions run as the rule's owner, inside
 * `runAsRule`, so every change they make is stamped with the rule (row 155)
 * and can never fire another rule. Failures go to the owner's inbox.
 */
@Injectable()
export class AutomationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly tasksService: TasksService,
  ) {}

  onModuleInit() {
    this.activity.onRecord((row) => this.onActivity(row));
    // Invoices do not write activity when they become overdue; a sweep records it once per invoice.
    registerJob("automations.overdue", () => this.sweepOverdue());
    if (!backgroundJobsEnabled()) return; // serverless: an external scheduler calls the job instead
    this.timer = setInterval(() => void this.sweepOverdue(), 30 * 60 * 1000);
    setTimeout(() => void this.sweepOverdue(), 30_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------------- CRUD ---------------- */

  async list(orgId: string) {
    const rows = await this.db.query.automationRules.findMany({ where: eq(automationRules.organizationId, orgId), with: { owner: { columns: { id: true, name: true } }, project: { columns: { id: true, name: true } } }, orderBy: [desc(automationRules.createdAt)] });
    return rows.map(shape);
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.automationRules.findFirst({ where: and(eq(automationRules.id, id), eq(automationRules.organizationId, orgId)), with: { owner: { columns: { id: true, name: true } }, project: { columns: { id: true, name: true } } } });
    if (!row) throw new NotFoundException("Rule not found");
    const runs = await this.db.query.automationRuns.findMany({ where: eq(automationRuns.ruleId, id), orderBy: [desc(automationRuns.createdAt)], limit: 50 });
    return { ...shape(row), runLog: runs.map((r) => ({ id: r.id, entityType: r.entityType, entityId: r.entityId, entityLabel: r.entityLabel, status: r.status, summary: r.summary, error: r.error, createdAt: r.createdAt.toISOString() })) };
  }

  async create(orgId: string, userId: string, dto: RuleDto) {
    if (!dto.name?.trim()) throw new BadRequestException("Name the rule");
    if (!dto.trigger) throw new BadRequestException("Pick a trigger");
    if (!dto.actions?.length) throw new BadRequestException("Add at least one action");
    await this.validate(orgId, dto);
    const [row] = await this.db
      .insert(automationRules)
      .values({ organizationId: orgId, name: dto.name.trim().slice(0, 160), enabled: dto.enabled ?? true, ownerId: dto.ownerId ?? userId, projectId: dto.projectId ?? null, trigger: dto.trigger, actions: dto.actions, createdById: userId })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "automation_created", changes: [{ field: "rule", from: null, to: row!.name }] });
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: RuleDto) {
    const before = await this.get(orgId, id);
    await this.validate(orgId, dto);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim().slice(0, 160) || before.name;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.ownerId !== undefined) patch.ownerId = dto.ownerId;
    if (dto.projectId !== undefined) patch.projectId = dto.projectId;
    if (dto.trigger !== undefined) patch.trigger = dto.trigger;
    if (dto.actions !== undefined) patch.actions = dto.actions;
    await this.db.update(automationRules).set(patch).where(eq(automationRules.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "automation_updated", changes: [{ field: "rule", from: before.name, to: (patch.name as string) ?? before.name }, ...(dto.enabled !== undefined && dto.enabled !== before.enabled ? [{ field: "enabled", from: String(before.enabled), to: String(dto.enabled) }] : [])] });
    return this.get(orgId, id);
  }

  async remove(orgId: string, userId: string, id: string) {
    const before = await this.get(orgId, id);
    await this.db.delete(automationRules).where(eq(automationRules.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "automation_deleted", changes: [{ field: "rule", from: before.name, to: null }] });
    return { id, deleted: true };
  }

  private async validate(orgId: string, dto: RuleDto) {
    if (dto.ownerId) {
      const m = await this.db.query.memberships.findFirst({ where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, dto.ownerId)), columns: { id: true } });
      if (!m) throw new BadRequestException("The owner must be a member of this workspace");
    }
    if (dto.projectId) {
      const p = await this.db.query.projects.findFirst({ where: and(eq(projects.id, dto.projectId), eq(projects.organizationId, orgId)), columns: { id: true } });
      if (!p) throw new BadRequestException("Project not found");
    }
    if (dto.trigger && !TRIGGERS.some((t) => t.type === dto.trigger!.type)) throw new BadRequestException("Unknown trigger");
    for (const a of dto.actions ?? []) {
      if (a.type === "notify" && !a.message?.trim()) throw new BadRequestException("The notify action needs a message");
      if (a.type === "notify" && a.to === "user" && !a.userId) throw new BadRequestException("Pick who to notify");
      if (a.type === "assign" && !a.userId) throw new BadRequestException("Pick who to assign");
      if (a.type === "move" && !a.statusName?.trim()) throw new BadRequestException("Name the status to move to");
      if (a.type === "create_task" && !a.title?.trim()) throw new BadRequestException("The new task needs a title");
    }
  }

  /* ---------------- trail (row 155) ---------------- */

  async runsFor(orgId: string, entityType: string, entityId: string) {
    const rows = await this.db.query.automationRuns.findMany({ where: and(eq(automationRuns.organizationId, orgId), eq(automationRuns.entityType, entityType), eq(automationRuns.entityId, entityId)), with: { rule: { columns: { id: true, name: true } } }, orderBy: [desc(automationRuns.createdAt)], limit: 50 });
    return rows.map((r) => ({ id: r.id, rule: r.rule ? { id: r.rule.id, name: r.rule.name } : null, status: r.status, summary: r.summary, error: r.error, createdAt: r.createdAt.toISOString() }));
  }

  /* ---------------- the engine ---------------- */

  /** Map an activity row to a trigger type (+ the "to" name for the matchers), or null when nothing fires. */
  private async triggerOf(row: ActivityRow): Promise<{ type: AutomationTriggerType; toName: string | null } | null> {
    const changes = (row.changes as { fields?: { field: string; from: unknown; to: unknown }[] } | null)?.fields ?? [];
    switch (row.entityType) {
      case "task": {
        if (row.action === "created") return { type: "task_created", toName: null };
        if (row.action === "completed") return { type: "task_completed", toName: null };
        const st = changes.find((c) => c.field === "statusId");
        if ((row.action === "status_changed" || row.action === "updated") && st?.to) {
          const s = await this.db.query.statuses.findFirst({ where: eq(statuses.id, String(st.to)), columns: { name: true } });
          return { type: "task_status_changed", toName: s?.name ?? null };
        }
        return null;
      }
      case "expense":
        return row.action === "approved" ? { type: "expense_approved", toName: null } : null;
      case "invoice":
        if (row.action === "overdue") return { type: "invoice_overdue", toName: null };
        if (row.action === "payment_recorded" || row.action === "paid_online") {
          const inv = await this.db.query.invoices.findFirst({ where: eq(invoices.id, row.entityId), columns: { status: true } });
          return inv?.status === "paid" ? { type: "invoice_paid", toName: null } : null;
        }
        return null;
      case "stage": {
        if (row.action !== "completed") return null;
        const s = await this.db.query.projectStages.findFirst({ where: eq(projectStages.id, row.entityId), columns: { name: true } });
        return { type: "stage_completed", toName: s?.name ?? null };
      }
      case "milestone":
        return row.action === "reached" ? { type: "milestone_reached", toName: null } : null;
      case "deal": {
        const st = changes.find((c) => c.field === "stageId" || c.field === "stage");
        if (!st?.to) return null;
        const s = await this.db.query.dealStages.findFirst({ where: eq(dealStages.id, String(st.to)), columns: { name: true } });
        return { type: "deal_stage_changed", toName: s?.name ?? String(st.to) };
      }
      default:
        return null;
    }
  }

  async onActivity(row: ActivityRow) {
    try {
      const fired = await this.triggerOf(row);
      if (!fired) return;
      const rules = await this.db.query.automationRules.findMany({ where: and(eq(automationRules.organizationId, row.organizationId), eq(automationRules.enabled, true)) });
      const candidates = rules.filter((r) => r.trigger.type === fired.type && (!r.trigger.toName || (fired.toName ?? "").toLowerCase() === r.trigger.toName.toLowerCase()));
      if (!candidates.length) return;
      const ctx = await this.context(row);
      for (const rule of candidates) {
        if (rule.projectId && rule.projectId !== ctx.projectId) continue;
        await this.run(rule, ctx, fired);
      }
    } catch (err) {
      this.logger.warn(`automation dispatch failed: ${(err as Error).message}`);
    }
  }

  private async run(rule: typeof automationRules.$inferSelect, ctx: Ctx, fired: { type: AutomationTriggerType; toName: string | null }) {
    const summary: string[] = [];
    let error: string | null = null;
    try {
      await this.activity.runAsRule(rule.id, async () => {
        for (const action of rule.actions) summary.push(await this.perform(rule, action, ctx, fired));
      });
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    await this.db.insert(automationRuns).values({ organizationId: ctx.orgId, ruleId: rule.id, entityType: ctx.entityType, entityId: ctx.entityId, entityLabel: ctx.label.slice(0, 255), status: error ? "failed" : "ok", summary, error });
    await this.db
      .update(automationRules)
      .set({ runs: sql`${automationRules.runs} + 1`, failures: error ? sql`${automationRules.failures} + 1` : automationRules.failures, lastRunAt: new Date(), lastError: error, updatedAt: new Date() })
      .where(eq(automationRules.id, rule.id));
    if (error) {
      // Row 153: "each rule has an owner who is alerted if a run fails."
      await this.notifications.notifyDirect({ orgId: ctx.orgId, receiverId: rule.ownerId, entityType: "workspace", entityId: ctx.orgId, verb: "automation_failed", title: `Automation "${rule.name}" failed on ${ctx.label}`, body: `${error}${summary.length ? ` · done before the failure: ${summary.join("; ")}` : ""}`, data: { ruleId: rule.id, link: `/settings?section=automations&rule=${rule.id}` }, category: "primary" }).catch(() => undefined);
    }
  }

  private async perform(rule: typeof automationRules.$inferSelect, action: AutomationAction, ctx: Ctx, fired: { type: AutomationTriggerType; toName: string | null }): Promise<string> {
    const actor = rule.ownerId;
    const fill = (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => ({ title: ctx.label, project: ctx.projectName ?? "", status: fired.toName ?? ctx.statusName ?? "", actor: ctx.actorName ?? "", rule: rule.name })[k] ?? "");
    switch (action.type) {
      case "notify": {
        const receivers = new Set<string>();
        if (action.to === "admins") for (const m of await this.db.query.memberships.findMany({ where: and(eq(memberships.organizationId, ctx.orgId), inArray(memberships.role, ["owner", "admin"])), columns: { userId: true } })) receivers.add(m.userId);
        if (action.to === "project_lead" && ctx.leadId) receivers.add(ctx.leadId);
        if (action.to === "assignees") for (const id of ctx.assigneeIds) receivers.add(id);
        if (action.to === "rule_owner") receivers.add(rule.ownerId);
        if (action.to === "user" && action.userId) receivers.add(action.userId);
        if (!receivers.size) return `notify: nobody to notify (${action.to})`;
        const message = fill(action.message);
        for (const r of receivers) await this.notifications.notifyDirect({ orgId: ctx.orgId, receiverId: r, actorId: null, entityType: ctx.entityType, entityId: ctx.entityId, verb: "automation", title: message.slice(0, 200), body: `Automation "${rule.name}" · ${ctx.label}`, data: { ruleId: rule.id, link: ctx.link }, category: "primary" });
        return `notified ${receivers.size} (${action.to})`;
      }
      case "assign": {
        if (!ctx.taskId) throw new BadRequestException("assign: this trigger is not about a task");
        await this.tasksService.addAssignee(ctx.orgId, actor, ctx.taskId, action.userId);
        const [u] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, action.userId));
        return `assigned ${u?.name ?? action.userId}`;
      }
      case "move": {
        if (!ctx.taskId || !ctx.spaceId) throw new BadRequestException("move: this trigger is not about a task");
        const st = await this.db.query.statuses.findFirst({ where: and(eq(statuses.spaceId, ctx.spaceId), sql`lower(${statuses.name}) = ${action.statusName.trim().toLowerCase()}`), columns: { id: true, name: true } });
        if (!st) throw new BadRequestException(`move: no status named "${action.statusName}" in this space`);
        await this.tasksService.update(ctx.orgId, actor, ctx.taskId, { statusId: st.id });
        return `moved to ${st.name}`;
      }
      case "create_task": {
        let listId = action.listId ?? ctx.listId ?? null;
        if (!listId && ctx.spaceId) listId = (await this.db.query.lists.findFirst({ where: eq(lists.spaceId, ctx.spaceId), columns: { id: true } }))?.id ?? null;
        if (!listId && ctx.projectId) {
          const p = await this.db.query.projects.findFirst({ where: eq(projects.id, ctx.projectId), columns: { spaceId: true } });
          if (p?.spaceId) listId = (await this.db.query.lists.findFirst({ where: eq(lists.spaceId, p.spaceId), columns: { id: true } }))?.id ?? null;
        }
        if (!listId) throw new BadRequestException("create task: no list to put it in — set one on the action");
        const due = action.dueInDays != null ? new Date(Date.now() + action.dueInDays * 86_400_000).toISOString() : undefined;
        const t = await this.tasksService.create(ctx.orgId, actor, { listId, title: fill(action.title).slice(0, 500), dueDate: due, assigneeIds: action.assigneeId ? [action.assigneeId] : undefined, description: `Created by automation "${rule.name}" from ${ctx.label}.` } as Parameters<TasksService["create"]>[2]);
        return `created task "${t?.title ?? fill(action.title)}"`;
      }
      default:
        return "unknown action";
    }
  }

  /** Everything the actions might need, resolved once per fire. */
  private async context(row: ActivityRow): Promise<Ctx> {
    const base: Ctx = { orgId: row.organizationId, entityType: row.entityType, entityId: row.entityId, label: row.entityType, projectId: null, projectName: null, leadId: null, taskId: null, listId: null, spaceId: null, assigneeIds: [], statusName: null, actorId: row.actorId, actorName: null, link: "/" };
    if (row.actorId) base.actorName = (await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.actorId)))[0]?.name ?? null;
    const withProject = async (projectId: string | null) => {
      if (!projectId) return;
      const p = await this.db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { id: true, name: true, leadId: true, spaceId: true } });
      if (p) Object.assign(base, { projectId: p.id, projectName: p.name, leadId: p.leadId, spaceId: base.spaceId ?? p.spaceId });
    };
    switch (row.entityType) {
      case "task": {
        const t = await this.db.query.tasks.findFirst({ where: eq(tasks.id, row.entityId), with: { list: { columns: { id: true, spaceId: true } }, status: { columns: { name: true } } } });
        if (!t) break;
        Object.assign(base, { label: t.title, taskId: t.id, listId: t.listId, spaceId: t.list?.spaceId ?? null, statusName: t.status?.name ?? null, link: `/t/${t.id}` });
        base.assigneeIds = (await this.db.select({ userId: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, t.id))).map((a) => a.userId);
        if (t.list?.spaceId) {
          const p = await this.db.query.projects.findFirst({ where: eq(projects.spaceId, t.list.spaceId), columns: { id: true } });
          await withProject(p?.id ?? null);
        }
        break;
      }
      case "expense": {
        const e = await this.db.query.expenses.findFirst({ where: eq(expenses.id, row.entityId), columns: { vendor: true, amount: true, currency: true, projectId: true } });
        if (e) Object.assign(base, { label: `${e.vendor} ${e.currency} ${e.amount.toFixed(2)}`, link: "/finance/expenses" });
        await withProject(e?.projectId ?? null);
        break;
      }
      case "invoice": {
        const i = await this.db.query.invoices.findFirst({ where: eq(invoices.id, row.entityId), columns: { number: true, title: true, projectId: true, companyId: true } });
        if (i) Object.assign(base, { label: `${i.number} ${i.title}`, link: `/finance/invoices/${row.entityId}` });
        await withProject(i?.projectId ?? null);
        break;
      }
      case "stage": {
        const s = await this.db.query.projectStages.findFirst({ where: eq(projectStages.id, row.entityId), columns: { name: true, projectId: true } });
        if (s) Object.assign(base, { label: s.name, link: `/projects/${s.projectId}` });
        await withProject(s?.projectId ?? null);
        break;
      }
      case "milestone": {
        const m = await this.db.query.milestones.findFirst({ where: eq(milestones.id, row.entityId), columns: { name: true, projectId: true } });
        if (m) Object.assign(base, { label: m.name, link: `/projects/${m.projectId}` });
        await withProject(m?.projectId ?? null);
        break;
      }
      case "deal": {
        const d = await this.db.query.deals.findFirst({ where: eq(deals.id, row.entityId), columns: { title: true, projectId: true, companyId: true } });
        if (d) Object.assign(base, { label: d.title, link: `/crm/deals?deal=${row.entityId}` });
        if (d?.companyId) base.label += ` (${(await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, d.companyId)))[0]?.name ?? ""})`;
        await withProject(d?.projectId ?? null);
        break;
      }
    }
    return base;
  }

  /** Overdue is a state, not an event: record it once per invoice so rules can fire on it. */
  async sweepOverdue() {
    try {
      const rows = await this.db.select({ id: invoices.id, orgId: invoices.organizationId, dueDate: invoices.dueDate }).from(invoices).where(and(isNull(invoices.archivedAt), inArray(invoices.status, ["sent", "viewed", "partially_paid"]), lt(invoices.dueDate, new Date())));
      if (!rows.length) return;
      // Once per invoice: the activity row itself is the marker.
      const done = new Set((await this.db.select({ id: activityLog.entityId }).from(activityLog).where(and(eq(activityLog.entityType, "invoice"), eq(activityLog.action, "overdue"), inArray(activityLog.entityId, rows.map((r) => r.id))))).map((x) => x.id));
      for (const r of rows) {
        if (done.has(r.id)) continue;
        await this.activity.record({ orgId: r.orgId, actorId: null, entityType: "invoice", entityId: r.id, action: "overdue", changes: [{ field: "dueDate", from: null, to: r.dueDate!.toISOString().slice(0, 10) }] });
      }
    } catch (err) {
      this.logger.warn(`overdue sweep failed: ${(err as Error).message}`);
    }
  }

  /** Test hook: fire a rule by hand against one record (owner/admin). */
  async testRun(orgId: string, id: string, target: { entityType: string; entityId: string }) {
    const rule = await this.db.query.automationRules.findFirst({ where: and(eq(automationRules.id, id), eq(automationRules.organizationId, orgId)) });
    if (!rule) throw new NotFoundException("Rule not found");
    const ctx = await this.context({ organizationId: orgId, entityType: target.entityType, entityId: target.entityId, actorId: null, action: "test", changes: null, id: "", ruleId: null, createdAt: new Date() });
    await this.run(rule, ctx, { type: rule.trigger.type, toName: rule.trigger.toName ?? null });
    return this.get(orgId, id);
  }
}

function shape(r: typeof automationRules.$inferSelect & { owner: { id: string; name: string }; project: { id: string; name: string } | null }) {
  return { id: r.id, name: r.name, enabled: r.enabled, owner: r.owner, project: r.project, trigger: r.trigger, actions: r.actions, runs: r.runs, failures: r.failures, lastRunAt: r.lastRunAt?.toISOString() ?? null, lastError: r.lastError, createdAt: r.createdAt.toISOString() };
}
