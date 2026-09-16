import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, expenses, invoicePayments, invoices, projects } from "../../db/schema.js";

export type Granularity = "month" | "quarter" | "year";
export type Basis = "cash" | "accrual";

export interface PnlQuery {
  from?: string;
  to?: string;
  granularity?: Granularity;
  basis?: Basis;
}

/**
 * Row 161: Profit & Loss.
 *
 * Cash basis (default, what Bonsai shows): income = payments received, dated by
 * the payment. Accrual: income = invoices issued (not draft/void), dated by the
 * issue date. Expenses are the ledger minus personal rows; refunds subtract.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async pnl(orgId: string, q: PnlQuery) {
    const granularity: Granularity = q.granularity ?? "month";
    const basis: Basis = q.basis ?? "cash";
    const now = new Date();
    const from = q.from ? startOfDay(q.from) : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const to = q.to ? endOfDay(q.to) : new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException("Invalid date range");
    if (to < from) throw new BadRequestException("End is before start");
    if (to.getTime() - from.getTime() > 5 * 366 * 86_400_000) throw new BadRequestException("Range is too long (5 years max)");

    // ---- income rows: {date, amount, invoiceId, projectId, companyId}
    const income =
      basis === "cash"
        ? await this.db
            .select({ date: invoicePayments.paidAt, amount: invoicePayments.amount, invoiceId: invoicePayments.invoiceId, projectId: invoices.projectId, companyId: invoices.companyId, currency: invoices.currency })
            .from(invoicePayments)
            .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
            .where(and(eq(invoicePayments.organizationId, orgId), gte(invoicePayments.paidAt, from), lt(invoicePayments.paidAt, to), isNull(invoices.archivedAt)))
        : await this.db
            .select({ date: invoices.issueDate, amount: invoices.total, invoiceId: invoices.id, projectId: invoices.projectId, companyId: invoices.companyId, currency: invoices.currency })
            .from(invoices)
            .where(and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), gte(invoices.issueDate, from), lt(invoices.issueDate, to), inArray(invoices.status, ["sent", "viewed", "partially_paid", "paid"])));

    const spend = await this.db
      .select({ date: expenses.date, amount: expenses.amount, kind: expenses.kind, category: expenses.category, projectId: expenses.projectId, vendor: expenses.vendor })
      .from(expenses)
      .where(and(eq(expenses.organizationId, orgId), isNull(expenses.archivedAt), eq(expenses.personal, false), gte(expenses.date, from), lt(expenses.date, to)));

    // ---- buckets
    const keys = bucketKeys(from, to, granularity);
    const buckets = new Map<string, { key: string; label: string; income: number; expenses: number; byCategory: Record<string, number> }>();
    for (const k of keys) buckets.set(k.key, { ...k, income: 0, expenses: 0, byCategory: {} });
    const bucketOf = (d: Date) => buckets.get(bucketKey(d, granularity));
    for (const r of income) {
      const b = bucketOf(r.date);
      if (b) b.income += r.amount;
    }
    const categoryTotals = new Map<string, number>();
    const vendorTotals = new Map<string, number>();
    for (const r of spend) {
      const signed = r.kind === "refund" ? -r.amount : r.amount;
      const cat = r.category ?? "Uncategorised";
      const b = bucketOf(r.date);
      if (b) {
        b.expenses += signed;
        b.byCategory[cat] = (b.byCategory[cat] ?? 0) + signed;
      }
      categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + signed);
      vendorTotals.set(r.vendor, (vendorTotals.get(r.vendor) ?? 0) + signed);
    }

    const totalIncome = round2(income.reduce((a, r) => a + r.amount, 0));
    const totalExpenses = round2(spend.reduce((a, r) => a + (r.kind === "refund" ? -r.amount : r.amount), 0));
    const net = round2(totalIncome - totalExpenses);

    // ---- by client
    const companyIds = [...new Set(income.map((r) => r.companyId).filter((x): x is string => Boolean(x)))];
    const companyRows = companyIds.length ? await this.db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds)) : [];
    const companyName = new Map(companyRows.map((c) => [c.id, c.name]));
    const byClient = new Map<string, { id: string | null; name: string; amount: number }>();
    for (const r of income) {
      const k = r.companyId ?? "none";
      const cur = byClient.get(k) ?? { id: r.companyId, name: r.companyId ? (companyName.get(r.companyId) ?? "Unknown") : "No client", amount: 0 };
      cur.amount += r.amount;
      byClient.set(k, cur);
    }

    // ---- by project (income - expenses = margin)
    const projectIds = [...new Set([...income.map((r) => r.projectId), ...spend.map((r) => r.projectId)].filter((x): x is string => Boolean(x)))];
    const projectRows = projectIds.length ? await this.db.select({ id: projects.id, name: projects.name, budgetAmount: projects.budgetAmount }).from(projects).where(inArray(projects.id, projectIds)) : [];
    const projectName = new Map(projectRows.map((p) => [p.id, p]));
    const byProject = new Map<string, { id: string | null; name: string; income: number; expenses: number }>();
    const proj = (id: string | null) => {
      const k = id ?? "none";
      let cur = byProject.get(k);
      if (!cur) {
        cur = { id, name: id ? (projectName.get(id)?.name ?? "Unknown") : "Not tied to a project", income: 0, expenses: 0 };
        byProject.set(k, cur);
      }
      return cur;
    };
    for (const r of income) proj(r.projectId).income += r.amount;
    for (const r of spend) proj(r.projectId).expenses += r.kind === "refund" ? -r.amount : r.amount;

    const currency = income[0]?.currency ?? "USD";
    return {
      basis,
      granularity,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      currency,
      totals: { income: totalIncome, expenses: totalExpenses, net, margin: totalIncome > 0 ? round2((net / totalIncome) * 100) : null, invoices: new Set(income.map((r) => r.invoiceId)).size, expenseCount: spend.length },
      buckets: [...buckets.values()].map((b) => ({ ...b, income: round2(b.income), expenses: round2(b.expenses), net: round2(b.income - b.expenses), byCategory: Object.fromEntries(Object.entries(b.byCategory).map(([k, v]) => [k, round2(v)])) })),
      categories: [...categoryTotals.entries()]
        .map(([category, amount]) => ({ category, amount: round2(amount), share: totalExpenses > 0 ? round2((amount / totalExpenses) * 100) : 0 }))
        .sort((a, b) => b.amount - a.amount),
      vendors: [...vendorTotals.entries()]
        .map(([vendor, amount]) => ({ vendor, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10),
      clients: [...byClient.values()].map((c) => ({ ...c, amount: round2(c.amount), share: totalIncome > 0 ? round2((c.amount / totalIncome) * 100) : 0 })).sort((a, b) => b.amount - a.amount),
      projects: [...byProject.values()]
        .map((p) => ({ ...p, income: round2(p.income), expenses: round2(p.expenses), margin: round2(p.income - p.expenses), marginPct: p.income > 0 ? round2(((p.income - p.expenses) / p.income) * 100) : null }))
        .sort((a, b) => b.income - a.income),
    };
  }

  /** Row 161: the same report as a CSV the accountant can open. */
  async pnlCsv(orgId: string, q: PnlQuery) {
    const r = await this.pnl(orgId, q);
    const cats = r.categories.map((c) => c.category);
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [];
    lines.push(`Profit & Loss (${r.basis} basis),${r.from} to ${r.to},${r.currency}`);
    lines.push("");
    lines.push(["Period", "Income", "Expenses", "Net", ...cats].map(esc).join(","));
    for (const b of r.buckets) lines.push([b.label, b.income.toFixed(2), b.expenses.toFixed(2), b.net.toFixed(2), ...cats.map((c) => (b.byCategory[c] ?? 0).toFixed(2))].map(esc).join(","));
    lines.push(["Total", r.totals.income.toFixed(2), r.totals.expenses.toFixed(2), r.totals.net.toFixed(2), ...cats.map((c) => (r.categories.find((x) => x.category === c)?.amount ?? 0).toFixed(2))].map(esc).join(","));
    lines.push("");
    lines.push("Income by client,Amount,Share %");
    for (const c of r.clients) lines.push([c.name, c.amount.toFixed(2), c.share].map(esc).join(","));
    lines.push("");
    lines.push("Project,Income,Expenses,Margin,Margin %");
    for (const p of r.projects) lines.push([p.name, p.income.toFixed(2), p.expenses.toFixed(2), p.margin.toFixed(2), p.marginPct ?? ""].map(esc).join(","));
    lines.push("");
    lines.push("Top vendors,Amount");
    for (const v of r.vendors) lines.push([v.vendor, v.amount.toFixed(2)].map(esc).join(","));
    return { csv: lines.join("\n"), filename: `pnl-${r.basis}-${r.from}-to-${r.to}.csv` };
  }
}

function startOfDay(s: string) {
  const d = new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
  return d;
}
function endOfDay(s: string) {
  const d = new Date(s.length === 10 ? `${s}T23:59:59.999Z` : s);
  return d;
}

function bucketKey(d: Date, g: Granularity) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (g === "year") return `${y}`;
  if (g === "quarter") return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function bucketKeys(from: Date, to: Date, g: Granularity): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  const cur = new Date(Date.UTC(from.getUTCFullYear(), g === "year" ? 0 : g === "quarter" ? Math.floor(from.getUTCMonth() / 3) * 3 : from.getUTCMonth(), 1));
  while (cur <= to && out.length < 120) {
    const key = bucketKey(cur, g);
    if (!seen.has(key)) {
      seen.add(key);
      const y = cur.getUTCFullYear();
      const m = cur.getUTCMonth();
      out.push({ key, label: g === "year" ? `${y}` : g === "quarter" ? `Q${Math.floor(m / 3) + 1} ${y}` : `${MONTHS[m]} ${y}` });
    }
    if (g === "year") cur.setUTCFullYear(y1(cur) + 1);
    else cur.setUTCMonth(cur.getUTCMonth() + (g === "quarter" ? 3 : 1));
  }
  return out;
}
function y1(d: Date) {
  return d.getUTCFullYear();
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
