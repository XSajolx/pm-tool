import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { expenses, projects, tasks, timeEntries, timesheetSubmissions, users } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { startOfWeek } from "../time/time.service.js";
import { ExpensesService } from "./expenses.service.js";
import { InvoicesService } from "./invoices.service.js";
import { RatesService } from "./rates.service.js";

export type GroupBy = "person" | "task" | "single";

export interface DraftFromUnbilledDto {
  projectId: string;
  /** Only work dated on or before this day (ISO). */
  through?: string | null;
  onlyApprovedHours?: boolean;
  groupBy?: GroupBy;
  includeExpenses?: boolean;
  /** Explicit subsets; omitted = everything eligible. */
  timeEntryIds?: string[] | null;
  expenseIds?: string[] | null;
  title?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const hours = (s: number) => Math.round((s / 3600) * 100) / 100;

/**
 * Row 136: what a project has earned but not yet invoiced — billable hours
 * (only from approved timesheet weeks, by default) and approved billable
 * expenses — and one call that turns it into a draft invoice. The same
 * numbers feed WIP (row 144), so they live in one place.
 */
@Injectable()
export class UnbilledService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly invoicesService: InvoicesService,
    private readonly expensesService: ExpensesService,
    private readonly rates: RatesService,
  ) {}

  async forProject(orgId: string, projectId: string, opts: { through?: string | null; onlyApprovedHours?: boolean } = {}) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)) });
    if (!project) throw new NotFoundException("Project not found");
    const onlyApproved = opts.onlyApprovedHours ?? true;
    const through = opts.through ? new Date(opts.through) : null;
    if (through) through.setUTCHours(23, 59, 59, 999);

    const rows = await this.db
      .select({
        id: timeEntries.id,
        userId: timeEntries.userId,
        userName: users.name,
        taskId: timeEntries.taskId,
        taskTitle: tasks.title,
        description: timeEntries.description,
        startedAt: timeEntries.startedAt,
        seconds: timeEntries.durationSeconds,
      })
      .from(timeEntries)
      .innerJoin(users, eq(users.id, timeEntries.userId))
      .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(and(eq(timeEntries.projectId, projectId), eq(timeEntries.billable, true), isNull(timeEntries.invoiceId), sql`${timeEntries.endedAt} is not null`, sql`${timeEntries.durationSeconds} > 0`, ...(through ? [lte(timeEntries.startedAt, through)] : [])))
      .orderBy(asc(timeEntries.startedAt));

    // Which (user, week) pairs are approved?
    const weeks = new Map<string, Set<number>>();
    const userIds = [...new Set(rows.map((r) => r.userId))];
    if (userIds.length) {
      const subs = await this.db.select({ userId: timesheetSubmissions.userId, weekStart: timesheetSubmissions.weekStart }).from(timesheetSubmissions).where(and(eq(timesheetSubmissions.organizationId, orgId), inArray(timesheetSubmissions.userId, userIds), eq(timesheetSubmissions.status, "approved")));
      for (const s of subs) {
        const set = weeks.get(s.userId) ?? new Set<number>();
        set.add(s.weekStart.getTime());
        weeks.set(s.userId, set);
      }
    }
    const approved = (r: (typeof rows)[number]) => weeks.get(r.userId)?.has(startOfWeek(r.startedAt).getTime()) ?? false;

    const eligible = rows.filter((r) => !onlyApproved || approved(r));
    const waiting = rows.filter((r) => onlyApproved && !approved(r));
    // Rows 140-141: the rate in force on the day of the work (project override → member card → project rate).
    const resolve = await this.rates.resolver(orgId, [projectId]);
    const entries = eligible.map((r) => {
      const rate = resolve(r.userId, projectId, r.startedAt).billRate;
      return { id: r.id, userId: r.userId, userName: r.userName, taskId: r.taskId, taskTitle: r.taskTitle, description: r.description, date: r.startedAt, seconds: r.seconds, hours: hours(r.seconds), rate, amount: round2(hours(r.seconds) * rate), approved: approved(r) };
    });
    const byPerson = groupSum(entries, (e) => e.userId, (e) => ({ id: e.userId, name: e.userName, rate: e.rate }));
    const byTask = groupSum(entries, (e) => e.taskId ?? "", (e) => ({ id: e.taskId, name: e.taskTitle ?? "No task" }));
    const exp = (await this.expensesService.billableFor(orgId, { projectId })).filter((e) => !through || new Date(e.date) <= through);

    const hoursAmount = round2(entries.reduce((a, e) => a + e.amount, 0));
    const expensesAmount = round2(exp.reduce((a, e) => a + e.billAmount, 0));
    return {
      project: { id: project.id, name: project.name, currency: project.currency, hourlyRate: project.hourlyRate, companyId: project.companyId },
      onlyApprovedHours: onlyApproved,
      through: through?.toISOString() ?? null,
      hours: {
        seconds: entries.reduce((a, e) => a + e.seconds, 0),
        hours: hours(entries.reduce((a, e) => a + e.seconds, 0)),
        amount: hoursAmount,
        rateMissing: entries.length > 0 && entries.some((e) => e.rate <= 0),
        entries,
        byPerson,
        byTask,
        awaitingApproval: { count: waiting.length, seconds: waiting.reduce((a, r) => a + r.seconds, 0), hours: hours(waiting.reduce((a, r) => a + r.seconds, 0)) },
      },
      expenses: { count: exp.length, amount: expensesAmount, items: exp },
      total: round2(hoursAmount + expensesAmount),
    };
  }

  /** Every active project's unbilled value in one list (row 144 WIP uses this). */
  async summary(orgId: string, opts: { onlyApprovedHours?: boolean } = {}) {
    const list = await this.db.query.projects.findMany({ where: and(eq(projects.organizationId, orgId), isNull(projects.archivedAt), sql`${projects.kind} <> 'internal'`), columns: { id: true } });
    const out = [];
    for (const p of list) {
      const u = await this.forProject(orgId, p.id, opts);
      if (u.hours.seconds > 0 || u.expenses.count > 0 || u.hours.awaitingApproval.count > 0) out.push({ project: u.project, hours: u.hours.hours, hoursAmount: u.hours.amount, awaitingHours: u.hours.awaitingApproval.hours, expensesAmount: u.expenses.amount, expensesCount: u.expenses.count, total: u.total, rateMissing: u.hours.rateMissing });
    }
    return out.sort((a, b) => b.total - a.total);
  }

  /** Draft invoice from the eligible work; the hours and expenses are stamped so they never bill twice. */
  async draft(orgId: string, userId: string, dto: DraftFromUnbilledDto) {
    const u = await this.forProject(orgId, dto.projectId, { through: dto.through, onlyApprovedHours: dto.onlyApprovedHours });
    const entries = dto.timeEntryIds ? u.hours.entries.filter((e) => dto.timeEntryIds!.includes(e.id)) : u.hours.entries;
    const exp = dto.includeExpenses === false ? [] : dto.expenseIds ? u.expenses.items.filter((e) => dto.expenseIds!.includes(e.id)) : u.expenses.items;
    if (!entries.length && !exp.length) throw new BadRequestException("Nothing unbilled to invoice");
    if (entries.length && u.hours.rateMissing) throw new BadRequestException("Some hours have no rate — set a rate card for the person, or an hourly rate on the project");

    const groupBy: GroupBy = dto.groupBy ?? "person";
    const items: { description: string; quantity: number; unitPrice: number }[] = [];
    const period = entries.length ? `${entries[0]!.date.toISOString().slice(0, 10)} – ${entries[entries.length - 1]!.date.toISOString().slice(0, 10)}` : "";
    if (groupBy === "single" && entries.length) {
      const secs = entries.reduce((a, e) => a + e.seconds, 0);
      const amount = entries.reduce((a, e) => a + e.amount, 0);
      items.push({ description: `Professional services — ${u.project.name} (${period})`, quantity: hours(secs), unitPrice: round2(amount / hours(secs)) });
    } else if (entries.length) {
      const groups = groupBy === "person" ? groupSum(entries, (e) => e.userId, (e) => ({ name: e.userName, rate: e.rate })) : groupSum(entries, (e) => e.taskId ?? "", (e) => ({ name: e.taskTitle ?? "General work", rate: e.rate }));
      // A person's rate may have changed mid-period: bill at the blended rate so the amount is exact.
      for (const g of groups) items.push({ description: `${g.name} — ${groupBy === "person" ? "hours" : "work"} on ${u.project.name} (${period})`, quantity: g.hours, unitPrice: g.hours ? round2(g.amount / g.hours) : 0 });
    }
    for (const e of exp) items.push({ description: `Expense — ${e.vendor}${e.description ? `: ${e.description}` : ""} (${new Date(e.date).toISOString().slice(0, 10)})`, quantity: 1, unitPrice: e.billAmount });

    const inv = await this.invoicesService.create(orgId, userId, { projectId: u.project.id, title: dto.title?.trim() || `${u.project.name} — work through ${new Date(dto.through ?? Date.now()).toISOString().slice(0, 10)}`, items });
    const now = new Date();
    if (entries.length) await this.db.update(timeEntries).set({ invoiceId: inv.id, updatedAt: now }).where(inArray(timeEntries.id, entries.map((e) => e.id)));
    if (exp.length) await this.db.update(expenses).set({ invoiceId: inv.id, updatedAt: now }).where(inArray(expenses.id, exp.map((e) => e.id)));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: inv.id, action: "drafted_from_unbilled", changes: [{ field: "hours", from: null, to: String(hours(entries.reduce((a, e) => a + e.seconds, 0))) }, { field: "expenses", from: null, to: String(exp.length) }] });
    return this.invoicesService.get(orgId, inv.id);
  }
}

function groupSum<T extends { seconds: number; amount: number }, M>(rows: T[], key: (r: T) => string, meta: (r: T) => M) {
  const map = new Map<string, M & { seconds: number; hours: number; amount: number; count: number }>();
  for (const r of rows) {
    const k = key(r);
    const cur = map.get(k) ?? { ...meta(r), seconds: 0, hours: 0, amount: 0, count: 0 };
    cur.seconds += r.seconds;
    cur.amount = round2(cur.amount + r.amount);
    cur.count++;
    cur.hours = hours(cur.seconds);
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.seconds - a.seconds);
}
