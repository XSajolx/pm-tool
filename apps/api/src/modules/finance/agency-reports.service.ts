import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { dealStages, deals, expenses, holidays, invoicePayments, invoices, leaveRequests, memberships, organizations, projects, tasks, timeEntries } from "../../db/schema.js";
import { RatesService } from "./rates.service.js";
import { UnbilledService } from "./unbilled.service.js";

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const hours = (s: number) => Math.round((s / 3600) * 100) / 100;
const OPEN = ["sent", "viewed", "partially_paid"] as const;
const ISSUED = ["sent", "viewed", "partially_paid", "paid"] as const;

export interface Range { from: Date; to: Date }

/**
 * Rows 142-146: the agency-level numbers — utilization, profitability, WIP,
 * aged receivables and the one-page KPI view. Every report returns rows that
 * can be exported as CSV and carries the ids needed to click through.
 * Owner/admin only: these are the numbers that include cost and margin.
 */
@Injectable()
export class AgencyReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly rates: RatesService,
    private readonly unbilled: UnbilledService,
  ) {}

  /* ---------------- row 142: utilization ---------------- */

  /** Available hours per member across a range: working days − holidays − approved leave, at each person's capacity. */
  async availableHours(orgId: string, range: Range) {
    const [org, members, offDays, leave] = await Promise.all([
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { workingDays: true } }),
      this.db.query.memberships.findMany({ where: and(eq(memberships.organizationId, orgId), isNull(memberships.deactivatedAt)), with: { user: { columns: { id: true, name: true } } } }),
      this.db.query.holidays.findMany({ where: and(eq(holidays.organizationId, orgId), gte(holidays.date, range.from), lt(holidays.date, range.to)) }),
      this.db.query.leaveRequests.findMany({ where: and(eq(leaveRequests.organizationId, orgId), eq(leaveRequests.status, "approved"), lt(leaveRequests.startDate, range.to), gte(leaveRequests.endDate, range.from)) }),
    ]);
    const orgDays = org?.workingDays ?? [1, 2, 3, 4, 5];
    const holidaySet = new Set(offDays.map((h) => h.date.toISOString().slice(0, 10)));
    const out = new Map<string, { userId: string; name: string; role: string; capacity: number; holidayHours: number; leaveHours: number; available: number }>();
    for (const m of members) {
      const working = m.workingDays?.length ? m.workingDays : orgDays;
      const perDay = working.length ? m.weeklyCapacityHours / working.length : 0;
      let capacity = 0;
      let holidayHours = 0;
      let leaveHours = 0;
      for (let d = new Date(range.from); d < range.to; d = new Date(d.getTime() + DAY)) {
        if (!working.includes(d.getUTCDay())) continue;
        capacity += perDay;
        const key = d.toISOString().slice(0, 10);
        if (holidaySet.has(key)) {
          holidayHours += perDay;
          continue;
        }
        const onLeave = leave.find((l) => l.userId === m.userId && l.startDate <= d && l.endDate >= d);
        if (onLeave) leaveHours += Math.min(perDay, onLeave.hoursPerDay);
      }
      out.set(m.userId, { userId: m.userId, name: m.user.name, role: m.role, capacity: round2(capacity), holidayHours: round2(holidayHours), leaveHours: round2(leaveHours), available: round2(Math.max(0, capacity - holidayHours - leaveHours)) });
    }
    return out;
  }

  async utilization(orgId: string, range: Range) {
    const avail = await this.availableHours(orgId, range);
    const rows = await this.db
      .select({ userId: timeEntries.userId, projectId: timeEntries.projectId, projectName: projects.name, projectKind: projects.kind, seconds: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int`, billable: sql<number>`coalesce(sum(${timeEntries.durationSeconds}) filter (where ${timeEntries.billable}), 0)::int` })
      .from(timeEntries)
      .innerJoin(projects, eq(projects.id, timeEntries.projectId))
      .where(and(eq(timeEntries.organizationId, orgId), gte(timeEntries.startedAt, range.from), lt(timeEntries.startedAt, range.to), sql`${timeEntries.endedAt} is not null`))
      .groupBy(timeEntries.userId, timeEntries.projectId, projects.name, projects.kind);
    const people = [...avail.values()].map((a) => {
      const mine = rows.filter((r) => r.userId === a.userId);
      const logged = mine.reduce((x, r) => x + r.seconds, 0);
      const billable = mine.filter((r) => r.projectKind !== "internal").reduce((x, r) => x + r.billable, 0);
      const internal = mine.filter((r) => r.projectKind === "internal").reduce((x, r) => x + r.seconds, 0);
      return {
        ...a,
        loggedHours: hours(logged),
        billableHours: hours(billable),
        internalHours: hours(internal),
        billableUtilizationPct: a.available > 0 ? Math.round((hours(billable) / a.available) * 100) : null,
        loggedUtilizationPct: a.available > 0 ? Math.round((hours(logged) / a.available) * 100) : null,
        projects: mine.filter((r) => r.projectKind !== "internal").map((r) => ({ id: r.projectId, name: r.projectName, hours: hours(r.seconds), billableHours: hours(r.billable) })).sort((x, y) => y.hours - x.hours),
      };
    });
    const team = people.reduce((t, p) => ({ available: t.available + p.available, logged: t.logged + p.loggedHours, billable: t.billable + p.billableHours, capacity: t.capacity + p.capacity }), { available: 0, logged: 0, billable: 0, capacity: 0 });
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      people: people.sort((x, y) => (y.billableUtilizationPct ?? -1) - (x.billableUtilizationPct ?? -1)),
      team: { ...team, available: round2(team.available), logged: round2(team.logged), billable: round2(team.billable), capacity: round2(team.capacity), billableUtilizationPct: team.available > 0 ? Math.round((team.billable / team.available) * 100) : null, loggedUtilizationPct: team.available > 0 ? Math.round((team.logged / team.available) * 100) : null },
    };
  }

  /* ---------------- row 143: profitability ---------------- */

  async profitability(orgId: string, range: Range | null) {
    const projs = await this.db.query.projects.findMany({ where: and(eq(projects.organizationId, orgId), isNull(projects.archivedAt), sql`${projects.kind} <> 'internal'`), with: { company: { columns: { id: true, name: true } } }, orderBy: [asc(projects.name)] });
    if (!projs.length) return { from: range?.from.toISOString() ?? null, to: range?.to.toISOString() ?? null, projects: [], totals: { ...empty(), marginPct: null as number | null } };
    const ids = projs.map((p) => p.id);
    const inRange = (col: typeof timeEntries.startedAt) => (range ? [gte(col, range.from), lt(col, range.to)] : []);
    const [entries, inv, pays, exp, resolve] = await Promise.all([
      this.db.select({ projectId: timeEntries.projectId, userId: timeEntries.userId, startedAt: timeEntries.startedAt, seconds: timeEntries.durationSeconds, billable: timeEntries.billable }).from(timeEntries).where(and(inArray(timeEntries.projectId, ids), sql`${timeEntries.endedAt} is not null`, ...inRange(timeEntries.startedAt))),
      this.db.select({ projectId: invoices.projectId, total: sql<number>`coalesce(sum(${invoices.total}), 0)::float`, n: sql<number>`count(*)::int` }).from(invoices).where(and(inArray(invoices.projectId, ids), isNull(invoices.archivedAt), inArray(invoices.status, [...ISSUED]), ...(range ? [gte(invoices.issueDate, range.from), lt(invoices.issueDate, range.to)] : []))).groupBy(invoices.projectId),
      this.db.select({ projectId: invoices.projectId, paid: sql<number>`coalesce(sum(${invoicePayments.amount}), 0)::float` }).from(invoicePayments).innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId)).where(and(inArray(invoices.projectId, ids), ...(range ? [gte(invoicePayments.paidAt, range.from), lt(invoicePayments.paidAt, range.to)] : []))).groupBy(invoices.projectId),
      this.db.select({ projectId: expenses.projectId, amount: sql<number>`coalesce(sum(case when ${expenses.kind} = 'refund' then -${expenses.amount} else ${expenses.amount} end), 0)::float`, contractor: sql<number>`coalesce(sum(case when ${expenses.contractorId} is not null then (case when ${expenses.kind} = 'refund' then -${expenses.amount} else ${expenses.amount} end) else 0 end), 0)::float` }).from(expenses).where(and(inArray(expenses.projectId, ids), isNull(expenses.archivedAt), eq(expenses.personal, false), sql`${expenses.approvalStatus} <> 'rejected'`, ...(range ? [gte(expenses.date, range.from), lt(expenses.date, range.to)] : []))).groupBy(expenses.projectId),
      this.rates.resolver(orgId, ids),
    ]);
    const invBy = new Map(inv.map((i) => [i.projectId, i]));
    const payBy = new Map(pays.map((p) => [p.projectId, p.paid]));
    const expBy = new Map(exp.map((e) => [e.projectId, e]));
    const rows = projs.map((p) => {
      const mine = entries.filter((e) => e.projectId === p.id);
      let labourCost = 0;
      let billableValue = 0;
      let seconds = 0;
      let missingCost = false;
      for (const e of mine) {
        const r = resolve(e.userId, p.id, e.startedAt);
        const h = e.seconds / 3600;
        seconds += e.seconds;
        labourCost += h * r.costRate;
        if (e.billable) billableValue += h * r.billRate;
        if (r.costRate <= 0) missingCost = true;
      }
      const revenue = round2(invBy.get(p.id)?.total ?? 0);
      const expensesAmt = round2(expBy.get(p.id)?.amount ?? 0);
      const contractorAmt = round2(expBy.get(p.id)?.contractor ?? 0);
      const cost = round2(labourCost + expensesAmt);
      const margin = round2(revenue - cost);
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        client: p.company?.name ?? p.clientName ?? null,
        currency: p.currency,
        budgetAmount: p.budgetAmount,
        revenue,
        invoiceCount: invBy.get(p.id)?.n ?? 0,
        collected: round2(payBy.get(p.id) ?? 0),
        hours: hours(seconds),
        labourCost: round2(labourCost),
        billableValue: round2(billableValue),
        expenses: expensesAmt,
        contractorCost: contractorAmt,
        cost,
        margin,
        marginPct: revenue > 0 ? Math.round((margin / revenue) * 100) : null,
        effectiveRate: seconds > 0 ? round2(revenue / (seconds / 3600)) : null,
        missingCostRates: missingCost && seconds > 0,
      };
    });
    const totals = rows.reduce((t, r) => ({ revenue: t.revenue + r.revenue, collected: t.collected + r.collected, hours: t.hours + r.hours, labourCost: t.labourCost + r.labourCost, expenses: t.expenses + r.expenses, cost: t.cost + r.cost, margin: t.margin + r.margin }), empty());
    return {
      from: range?.from.toISOString() ?? null,
      to: range?.to.toISOString() ?? null,
      projects: rows.sort((a, b) => b.margin - a.margin),
      totals: { ...roundAll(totals), marginPct: totals.revenue > 0 ? Math.round((totals.margin / totals.revenue) * 100) : null },
    };
  }

  /* ---------------- row 144: WIP ---------------- */

  async wip(orgId: string, onlyApproved = true) {
    const rows = await this.unbilled.summary(orgId, { onlyApprovedHours: onlyApproved });
    const totals = rows.reduce((t, r) => ({ hours: t.hours + r.hours, hoursAmount: t.hoursAmount + r.hoursAmount, awaitingHours: t.awaitingHours + r.awaitingHours, expensesAmount: t.expensesAmount + r.expensesAmount, total: t.total + r.total }), { hours: 0, hoursAmount: 0, awaitingHours: 0, expensesAmount: 0, total: 0 });
    return { onlyApproved, projects: rows, totals: { hours: round2(totals.hours), hoursAmount: round2(totals.hoursAmount), awaitingHours: round2(totals.awaitingHours), expensesAmount: round2(totals.expensesAmount), total: round2(totals.total) } };
  }

  /* ---------------- row 145: aged receivables ---------------- */

  async agedReceivables(orgId: string, asOf = new Date()) {
    const rows = await this.db.query.invoices.findMany({ where: and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), inArray(invoices.status, [...OPEN])), with: { company: { columns: { id: true, name: true, email: true } }, contact: { columns: { id: true, firstName: true, lastName: true, email: true } } }, orderBy: [asc(invoices.dueDate)] });
    const bucketOf = (due: Date | null) => {
      if (!due || due >= asOf) return "current" as const;
      const days = Math.floor((asOf.getTime() - due.getTime()) / DAY);
      return days <= 30 ? ("d1_30" as const) : days <= 60 ? ("d31_60" as const) : days <= 90 ? ("d61_90" as const) : ("d90plus" as const);
    };
    const BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90plus"] as const;
    const zero = () => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 });
    const clients = new Map<string, { id: string | null; name: string; email: string | null; buckets: ReturnType<typeof zero>; invoices: { id: string; number: string; title: string; dueDate: Date | null; daysOverdue: number; balance: number; currency: string; bucket: (typeof BUCKETS)[number] }[] }>();
    const totals = zero();
    for (const r of rows) {
      const balance = round2(Math.max(0, r.total - r.amountPaid));
      if (balance <= 0) continue;
      const key = r.companyId ?? r.contactId ?? "none";
      const name = (r.company?.name ?? (r.contact ? [r.contact.firstName, r.contact.lastName].filter(Boolean).join(" ") : "")) || "No client";
      const c = clients.get(key) ?? { id: r.companyId, name, email: r.company?.email ?? r.contact?.email ?? null, buckets: zero(), invoices: [] };
      const b = bucketOf(r.dueDate);
      c.buckets[b] = round2(c.buckets[b] + balance);
      c.buckets.total = round2(c.buckets.total + balance);
      totals[b] = round2(totals[b] + balance);
      totals.total = round2(totals.total + balance);
      c.invoices.push({ id: r.id, number: r.number, title: r.title, dueDate: r.dueDate, daysOverdue: r.dueDate && r.dueDate < asOf ? Math.floor((asOf.getTime() - r.dueDate.getTime()) / DAY) : 0, balance, currency: r.currency, bucket: b });
      clients.set(key, c);
    }
    const list = [...clients.values()].sort((a, b) => b.buckets.d90plus - a.buckets.d90plus || b.buckets.d61_90 - a.buckets.d61_90 || b.buckets.total - a.buckets.total);
    return { asOf: asOf.toISOString(), clients: list, totals, overdue: round2(totals.total - totals.current) };
  }

  /* ---------------- row 146: KPI dashboard ---------------- */

  async kpis(orgId: string) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [util, wip, ar, openTasks, activeProjects, pipeline, invoicedActive, profit] = await Promise.all([
      this.utilization(orgId, { from: monthStart, to: now }),
      this.wip(orgId, true),
      this.agedReceivables(orgId, now),
      this.db.select({ n: sql<number>`count(*)::int`, overdue: sql<number>`count(*) filter (where ${tasks.dueDate} < now() and ${tasks.completedAt} is null)::int` }).from(tasks).where(and(eq(tasks.organizationId, orgId), isNull(tasks.archivedAt), isNull(tasks.completedAt))),
      this.db.select({ n: sql<number>`count(*)::int`, budget: sql<number>`coalesce(sum(${projects.budgetAmount}), 0)::float` }).from(projects).where(and(eq(projects.organizationId, orgId), isNull(projects.archivedAt), eq(projects.status, "active"), sql`${projects.kind} <> 'internal'`)),
      this.db.select({ n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${deals.value}), 0)::float`, weighted: sql<number>`coalesce(sum(${deals.value} * ${deals.probability} / 100.0), 0)::float` }).from(deals).innerJoin(dealStages, eq(dealStages.id, deals.stageId)).where(and(eq(deals.organizationId, orgId), isNull(deals.archivedAt), eq(dealStages.kind, "open"))),
      this.db.select({ total: sql<number>`coalesce(sum(${invoices.total}), 0)::float` }).from(invoices).innerJoin(projects, eq(projects.id, invoices.projectId)).where(and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), inArray(invoices.status, [...ISSUED]), eq(projects.status, "active"))),
      this.profitability(orgId, { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: now }),
    ]);
    const backlogValue = round2(Math.max(0, (activeProjects[0]?.budget ?? 0) - (invoicedActive[0]?.total ?? 0)));
    return {
      asOf: now.toISOString(),
      backlog: { activeProjects: activeProjects[0]?.n ?? 0, contractedValue: round2(activeProjects[0]?.budget ?? 0), invoicedSoFar: round2(invoicedActive[0]?.total ?? 0), remainingValue: backlogValue, openTasks: openTasks[0]?.n ?? 0, overdueTasks: openTasks[0]?.overdue ?? 0 },
      wip: { total: wip.totals.total, hours: wip.totals.hours, awaitingHours: wip.totals.awaitingHours, projects: wip.projects.length },
      receivables: { outstanding: ar.totals.total, overdue: ar.overdue, over90: ar.totals.d90plus, clients: ar.clients.length },
      utilization: { billablePct: util.team.billableUtilizationPct, loggedPct: util.team.loggedUtilizationPct, billableHours: util.team.billable, available: util.team.available, from: util.from },
      pipeline: { openDeals: pipeline[0]?.n ?? 0, value: round2(pipeline[0]?.value ?? 0), weighted: round2(pipeline[0]?.weighted ?? 0) },
      profitability: { revenueYtd: profit.totals.revenue, marginYtd: profit.totals.margin, marginPct: profit.totals.marginPct },
    };
  }

  /* ---------------- CSV ---------------- */

  csv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]) {
    const esc = (v: unknown) => {
      const s = v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.map((c) => esc(c.label)).join(","), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(","))].join("\n");
  }
}

function empty() {
  return { revenue: 0, collected: 0, hours: 0, labourCost: 0, expenses: 0, cost: 0, margin: 0 };
}
function roundAll<T extends Record<string, number>>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)])) as T;
}
