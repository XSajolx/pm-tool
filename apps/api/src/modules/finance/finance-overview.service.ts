import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, contracts, invoicePayments, invoiceSchedules, invoices } from "../../db/schema.js";
import { ExpensesService } from "./expenses.service.js";
import { InvoicesService } from "./invoices.service.js";
import { ProfitFirstService } from "./profit-first.service.js";
import { ReportsService } from "./reports.service.js";
import { SchedulesService } from "./schedules.service.js";
import { TaxService } from "./tax.service.js";

const OPEN = ["sent", "viewed", "partially_paid"] as const;

/** Row 164: the money view in one call — per client, and for the whole workspace. */
@Injectable()
export class FinanceOverviewService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly invoices: InvoicesService,
    private readonly expenses: ExpensesService,
    private readonly reports: ReportsService,
    private readonly profitFirst: ProfitFirstService,
    private readonly schedules: SchedulesService,
    private readonly tax: TaxService,
  ) {}

  /** Billing tab on a company: every invoice, what is owed, what they have paid over time, how fast they pay. */
  async companyBilling(orgId: string, companyId: string) {
    const company = await this.db.query.companies.findFirst({ where: and(eq(companies.id, companyId), eq(companies.organizationId, orgId)), columns: { id: true, name: true } });
    if (!company) throw new NotFoundException("Company not found");
    const list = await this.invoices.list(orgId, { companyId });
    const payments = await this.db
      .select({ amount: invoicePayments.amount, paidAt: invoicePayments.paidAt, invoiceId: invoicePayments.invoiceId, issueDate: invoices.issueDate, invoiceTotal: invoices.total, number: invoices.number })
      .from(invoicePayments)
      .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
      .where(and(eq(invoices.organizationId, orgId), eq(invoices.companyId, companyId), isNull(invoices.archivedAt)))
      .orderBy(desc(invoicePayments.paidAt));
    const now = new Date();
    const year = now.getUTCFullYear();
    const open = list.filter((i) => (OPEN as readonly string[]).includes(i.status));
    const outstanding = round2(open.reduce((a, i) => a + i.balanceDue, 0));
    const overdueList = open.filter((i) => i.overdue);
    const overdue = round2(overdueList.reduce((a, i) => a + i.balanceDue, 0));
    const lifetime = round2(payments.reduce((a, p) => a + p.amount, 0));
    const thisYear = round2(payments.filter((p) => p.paidAt.getUTCFullYear() === year).reduce((a, p) => a + p.amount, 0));
    // Days-to-pay: for fully paid invoices, from issue to the last payment.
    const paidInvoices = list.filter((i) => i.status === "paid" && i.paidAt);
    const days = paidInvoices.map((i) => Math.max(0, Math.round((new Date(i.paidAt!).getTime() - new Date(i.issueDate).getTime()) / 86_400_000)));
    const avgDaysToPay = days.length ? Math.round(days.reduce((a, d) => a + d, 0) / days.length) : null;
    const schedules = await this.db.query.invoiceSchedules.findMany({ where: and(eq(invoiceSchedules.organizationId, orgId), eq(invoiceSchedules.companyId, companyId), isNull(invoiceSchedules.archivedAt), eq(invoiceSchedules.status, "active")), columns: { id: true, name: true, nextRunAt: true, every: true, unit: true } });
    const contractRows = await this.db.query.contracts.findMany({ where: and(eq(contracts.organizationId, orgId), eq(contracts.companyId, companyId), isNull(contracts.archivedAt)), columns: { id: true, number: true, title: true, status: true, signedAt: true }, orderBy: [desc(contracts.createdAt)], limit: 10 });
    return {
      company,
      totals: { outstanding, overdue, overdueCount: overdueList.length, openCount: open.length, lifetime, thisYear, invoiced: round2(list.filter((i) => i.status !== "draft" && i.status !== "void").reduce((a, i) => a + i.total, 0)), draftCount: list.filter((i) => i.status === "draft").length, avgDaysToPay, lastPaymentAt: payments[0]?.paidAt ?? null },
      invoices: list,
      payments: payments.slice(0, 20).map((p) => ({ amount: p.amount, paidAt: p.paidAt, invoiceId: p.invoiceId, number: p.number })),
      schedules: schedules.map((s) => ({ id: s.id, name: s.name, nextRunAt: s.nextRunAt, every: s.every, unit: s.unit })),
      contracts: contractRows,
    };
  }

  /** Finance tiles for the dashboard: this month, year to date, what is owed, what is set aside, what is coming. */
  async dashboard(orgId: string) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const monthFrom = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const monthTo = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    const [month, ytd, inv, exp, pf, sched, taxYear] = await Promise.all([
      this.reports.pnl(orgId, { from: monthFrom, to: monthTo, granularity: "month", basis: "cash" }),
      this.reports.pnl(orgId, { from: `${y}-01-01`, to: `${y}-12-31`, granularity: "month", basis: "cash" }),
      this.invoices.summary(orgId),
      this.expenses.summary(orgId),
      this.profitFirst.overview(orgId).catch(() => null),
      this.schedules.summary(orgId),
      this.tax.year(orgId).catch(() => null),
    ]);
    const [awaiting] = await this.db.select({ n: sql<number>`count(*)::int` }).from(contracts).where(and(eq(contracts.organizationId, orgId), isNull(contracts.archivedAt), inArray(contracts.status, ["sent", "viewed"])));
    const recent = await this.db
      .select({ amount: invoicePayments.amount, paidAt: invoicePayments.paidAt, invoiceId: invoicePayments.invoiceId, number: invoices.number, companyId: invoices.companyId })
      .from(invoicePayments)
      .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
      .where(and(eq(invoicePayments.organizationId, orgId), isNull(invoices.archivedAt)))
      .orderBy(desc(invoicePayments.paidAt))
      .limit(5);
    const companyIds = [...new Set(recent.map((r) => r.companyId).filter((x): x is string => Boolean(x)))];
    const names = companyIds.length ? await this.db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds)) : [];
    const nameOf = new Map(names.map((c) => [c.id, c.name]));
    const nextTax = taxYear?.nextDue ?? null;
    return {
      currency: month.currency,
      month: { income: month.totals.income, expenses: month.totals.expenses, net: month.totals.net, label: new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) },
      ytd: { income: ytd.totals.income, expenses: ytd.totals.expenses, net: ytd.totals.net, margin: ytd.totals.margin },
      receivables: { outstanding: inv.outstanding, overdue: inv.overdue, overdueCount: inv.overdueCount, openCount: inv.openCount, drafts: inv.drafts },
      expenses: { thisMonth: exp.thisMonth, uncategorised: exp.uncategorised, unbilledBillable: exp.unbilledBillable },
      profitFirst: pf?.config.enabled ? { buckets: pf.buckets.map((b) => ({ key: b.key, label: b.label, balance: b.balance })), untransferred: pf.totals.untransferred } : null,
      recurring: { active: sched.active, nextRunAt: sched.nextRunAt },
      contractsAwaiting: awaiting?.n ?? 0,
      nextTax: nextTax ? { label: nextTax.label, dueDate: nextTax.dueDate, remaining: nextTax.remaining, status: nextTax.status, daysToDue: nextTax.daysToDue } : null,
      recentPayments: recent.map((r) => ({ amount: r.amount, paidAt: r.paidAt, invoiceId: r.invoiceId, number: r.number, company: r.companyId ? (nameOf.get(r.companyId) ?? null) : null })),
    };
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
