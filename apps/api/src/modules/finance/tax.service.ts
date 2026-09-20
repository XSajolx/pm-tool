import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { memberships, organizations, reminders, taxPayments, type TaxSettings } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { ProfitFirstService } from "./profit-first.service.js";
import { ReportsService } from "./reports.service.js";
import { backgroundJobsEnabled, registerJob } from "../../common/jobs.js";

/**
 * Calendar quarters, each due on the 15th of the following month (Q4 → 15 Jan
 * next year). US filers on the IRS schedule (Jun 15 / Sep 15) can change the
 * dates in settings. Rates are placeholders to edit with an accountant.
 */
export const DEFAULT_TAX: TaxSettings = {
  jurisdictions: [
    { key: "federal", label: "Federal income tax", ratePct: 22 },
    { key: "state", label: "State income tax", ratePct: 5 },
    { key: "se", label: "Self-employment tax", ratePct: 15.3 },
  ],
  basis: "net",
  deductionPct: 0,
  dueDates: [
    { q: 1, month: 4, day: 15 },
    { q: 2, month: 7, day: 15 },
    { q: 3, month: 10, day: 15 },
    { q: 4, month: 1, day: 15 },
  ],
  reminderDaysBefore: 14,
  enabled: true,
};

export interface TaxSettingsWrite {
  jurisdictions?: { key?: string; label: string; ratePct: number }[];
  basis?: "net" | "income";
  deductionPct?: number;
  dueDates?: { q: 1 | 2 | 3 | 4; month: number; day: number }[];
  reminderDaysBefore?: number;
  enabled?: boolean;
}

export interface TaxPaymentWrite {
  year: number;
  quarter: number;
  jurisdiction?: string | null;
  amount: number;
  paidAt?: string | null;
  reference?: string | null;
  note?: string | null;
}

@Injectable()
export class TaxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaxService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly reports: ReportsService,
    private readonly profitFirst: ProfitFirstService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  onModuleInit() {
    registerJob("finance.tax", () => this.sweep());
    if (!backgroundJobsEnabled()) return; // serverless: an external scheduler calls the job instead
    this.timer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    setTimeout(() => void this.sweep(), 12_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------------- settings ---------------- */

  async settings(orgId: string): Promise<TaxSettings> {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { taxSettings: true } });
    return normalise(org?.taxSettings ?? null);
  }

  async updateSettings(orgId: string, userId: string, dto: TaxSettingsWrite) {
    const cur = await this.settings(orgId);
    const next: TaxSettings = { ...cur };
    if (dto.jurisdictions) {
      next.jurisdictions = dto.jurisdictions
        .filter((j) => j.label?.trim())
        .slice(0, 8)
        .map((j, i) => ({ key: (j.key || slug(j.label) || `j${i + 1}`).slice(0, 40), label: j.label.trim().slice(0, 60), ratePct: Math.min(100, Math.max(0, round2(Number(j.ratePct) || 0))) }));
    }
    if (dto.basis) next.basis = dto.basis;
    if (dto.deductionPct !== undefined) next.deductionPct = Math.min(100, Math.max(0, round2(Number(dto.deductionPct) || 0)));
    if (dto.dueDates) {
      next.dueDates = [1, 2, 3, 4].map((q) => {
        const d = dto.dueDates!.find((x) => x.q === q) ?? cur.dueDates.find((x) => x.q === q)!;
        if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31) throw new BadRequestException(`Invalid due date for Q${q}`);
        return { q: q as 1 | 2 | 3 | 4, month: d.month, day: d.day };
      });
    }
    if (dto.reminderDaysBefore !== undefined) next.reminderDaysBefore = Math.min(90, Math.max(0, Math.round(dto.reminderDaysBefore)));
    if (dto.enabled !== undefined) next.enabled = dto.enabled;
    await this.db.update(organizations).set({ taxSettings: next, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "tax_settings_updated" });
    return next;
  }

  /* ---------------- the estimate ---------------- */

  async year(orgId: string, year?: number) {
    const cfg = await this.settings(orgId);
    const y = year ?? new Date().getUTCFullYear();
    const now = new Date();
    const paid = await this.db.query.taxPayments.findMany({ where: and(eq(taxPayments.organizationId, orgId), eq(taxPayments.year, y)), orderBy: [desc(taxPayments.paidAt)] });
    const pf = await this.profitFirst.overview(orgId).catch(() => null);
    const taxBucket = pf?.config.enabled ? (pf.buckets.find((b) => b.key === "tax")?.balance ?? null) : null;
    const totalRate = cfg.jurisdictions.reduce((a, j) => a + j.ratePct, 0);

    const quarters = [];
    for (const q of [1, 2, 3, 4] as const) {
      const from = new Date(Date.UTC(y, (q - 1) * 3, 1));
      const to = new Date(Date.UTC(y, q * 3, 0, 23, 59, 59, 999));
      const report = await this.reports.pnl(orgId, { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), granularity: "quarter", basis: "cash" });
      const income = report.totals.income;
      const expenses = report.totals.expenses;
      const net = round2(income - expenses);
      const base = cfg.basis === "income" ? income : net;
      const taxable = round2(Math.max(0, base) * (1 - cfg.deductionPct / 100));
      const byJurisdiction = cfg.jurisdictions.map((j) => ({ key: j.key, label: j.label, ratePct: j.ratePct, amount: round2((taxable * j.ratePct) / 100) }));
      const estimate = round2(byJurisdiction.reduce((a, j) => a + j.amount, 0));
      const dueDate = dueDateFor(cfg, y, q);
      const qPaid = paid.filter((p) => p.quarter === q);
      const paidTotal = round2(qPaid.reduce((a, p) => a + p.amount, 0));
      const remaining = round2(Math.max(0, estimate - paidTotal));
      const ended = now > to;
      const daysToDue = now > dueDate ? -Math.ceil((now.getTime() - dueDate.getTime()) / 86_400_000) : Math.ceil((dueDate.getTime() - now.getTime()) / 86_400_000);
      const status: "future" | "in_progress" | "upcoming" | "due_soon" | "overdue" | "paid" | "none" =
        ended && estimate === 0 && paidTotal === 0 ? "none" : remaining <= 0.005 && paidTotal > 0 ? "paid" : now < from ? "future" : now > dueDate ? "overdue" : !ended ? "in_progress" : daysToDue <= cfg.reminderDaysBefore ? "due_soon" : "upcoming";
      quarters.push({
        q,
        label: `Q${q} ${y}`,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        dueDate: dueDate.toISOString().slice(0, 10),
        daysToDue,
        income,
        expenses,
        net,
        taxable,
        byJurisdiction,
        estimate,
        paid: paidTotal,
        remaining,
        status,
        payments: qPaid.map((p) => ({ id: p.id, jurisdiction: p.jurisdiction, amount: p.amount, paidAt: p.paidAt, reference: p.reference, note: p.note })),
      });
    }
    const ytd = {
      income: round2(quarters.reduce((a, q) => a + q.income, 0)),
      expenses: round2(quarters.reduce((a, q) => a + q.expenses, 0)),
      net: round2(quarters.reduce((a, q) => a + q.net, 0)),
      estimate: round2(quarters.reduce((a, q) => a + q.estimate, 0)),
      paid: round2(quarters.reduce((a, q) => a + q.paid, 0)),
      remaining: round2(quarters.reduce((a, q) => a + q.remaining, 0)),
      effectiveRatePct: totalRate,
    };
    // Annualised projection from the quarters that have data so far (this year only).
    const elapsed = quarters.filter((q) => new Date(q.from) <= now);
    const withData = elapsed.filter((q) => q.income > 0 || q.expenses > 0);
    const projection = y === now.getUTCFullYear() && withData.length ? { net: round2((ytd.net / Math.max(1, elapsed.length)) * 4), estimate: round2((ytd.estimate / Math.max(1, elapsed.length)) * 4) } : null;
    return { year: y, settings: cfg, quarters, ytd, projection, taxBucketBalance: taxBucket, nextDue: quarters.find((q) => q.status === "due_soon" || q.status === "upcoming" || q.status === "overdue") ?? null };
  }

  /* ---------------- payments ---------------- */

  async recordPayment(orgId: string, userId: string, dto: TaxPaymentWrite) {
    if (![1, 2, 3, 4].includes(dto.quarter)) throw new BadRequestException("Quarter must be 1-4");
    if (!(dto.amount > 0)) throw new BadRequestException("Amount must be greater than zero");
    const cfg = await this.settings(orgId);
    if (dto.jurisdiction && !cfg.jurisdictions.some((j) => j.key === dto.jurisdiction)) throw new BadRequestException("Unknown jurisdiction");
    const [row] = await this.db
      .insert(taxPayments)
      .values({ organizationId: orgId, createdById: userId, year: dto.year, quarter: dto.quarter, jurisdiction: dto.jurisdiction || null, amount: round2(dto.amount), paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(), reference: dto.reference?.trim() || null, note: dto.note?.trim() || null })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "tax_payment_recorded", changes: [{ field: `Q${dto.quarter} ${dto.year}`, from: null, to: row!.amount }] });
    return this.year(orgId, dto.year);
  }

  async removePayment(orgId: string, userId: string, id: string) {
    const p = await this.db.query.taxPayments.findFirst({ where: and(eq(taxPayments.id, id), eq(taxPayments.organizationId, orgId)) });
    if (!p) throw new NotFoundException("Payment not found");
    await this.db.delete(taxPayments).where(eq(taxPayments.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "tax_payment_removed", changes: [{ field: `Q${p.quarter} ${p.year}`, from: p.amount, to: null }] });
    return this.year(orgId, p.year);
  }

  /* ---------------- reminders (row 163: "an Inbox reminder before each date") ---------------- */

  /** Once per quarter per admin: "due in N days" inside the reminder window, and "overdue" once the date passes. */
  async sweep() {
    let sent = 0;
    try {
      const orgs = await this.db.select({ id: organizations.id, taxSettings: organizations.taxSettings }).from(organizations);
      const now = new Date();
      for (const org of orgs) {
        const cfg = normalise(org.taxSettings);
        if (!cfg.enabled) continue;
        for (const y of [now.getUTCFullYear() - 1, now.getUTCFullYear()]) {
          for (const q of [1, 2, 3, 4] as const) {
            const due = dueDateFor(cfg, y, q);
            const overdue = now > due;
            const days = overdue ? -Math.ceil((now.getTime() - due.getTime()) / 86_400_000) : Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
            const kind = overdue ? "tax_overdue" : days <= cfg.reminderDaysBefore ? "tax_due_soon" : null;
            if (!kind || days < -30) continue;
            const year = await this.year(org.id, y);
            const quarter = year.quarters.find((x) => x.q === q)!;
            if (quarter.remaining <= 0.005) continue;
            const admins = await this.db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.organizationId, org.id), inArray(memberships.role, ["owner", "admin"]), isNull(memberships.deactivatedAt)));
            for (const a of admins) {
              const claimed = await this.db.insert(reminders).values({ organizationId: org.id, receiverId: a.userId, entityType: "tax", entityId: org.id, kind: `${kind}_${y}q${q}`.slice(0, 24), dueAt: due }).onConflictDoNothing().returning({ id: reminders.id });
              if (!claimed.length) continue;
              await this.notifications.notifyDirect({
                orgId: org.id,
                receiverId: a.userId,
                entityType: "tax",
                entityId: org.id,
                verb: kind,
                title: kind === "tax_overdue" ? `Q${q} ${y} estimated tax was due ${quarter.dueDate}` : `Q${q} ${y} estimated tax is due in ${days} day${days === 1 ? "" : "s"} (${quarter.dueDate})`,
                body: `Estimate ${quarter.estimate.toLocaleString("en-US", { minimumFractionDigits: 2 })}${quarter.paid ? `, paid ${quarter.paid.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : ""} — ${quarter.remaining.toLocaleString("en-US", { minimumFractionDigits: 2 })} still to pay. Estimates only; confirm with your accountant.`,
                data: { year: y, quarter: q },
              });
              sent++;
            }
          }
        }
      }
      if (sent) this.logger.log(`sent ${sent} tax reminder(s)`);
    } catch (err) {
      this.logger.warn(`tax reminder sweep failed: ${(err as Error).message}`);
    }
    return { sent };
  }
}

function dueDateFor(cfg: TaxSettings, year: number, q: 1 | 2 | 3 | 4) {
  const d = cfg.dueDates.find((x) => x.q === q) ?? DEFAULT_TAX.dueDates[q - 1]!;
  // A due month earlier than the quarter's own months means it falls in the following year (Q4 → January).
  const y = d.month <= (q - 1) * 3 ? year + 1 : year;
  return new Date(Date.UTC(y, d.month - 1, d.day, 23, 59, 59));
}

function normalise(raw: TaxSettings | null): TaxSettings {
  if (!raw) return { ...DEFAULT_TAX, jurisdictions: DEFAULT_TAX.jurisdictions.map((j) => ({ ...j })), dueDates: DEFAULT_TAX.dueDates.map((d) => ({ ...d })) };
  return {
    jurisdictions: raw.jurisdictions?.length ? raw.jurisdictions : DEFAULT_TAX.jurisdictions,
    basis: raw.basis === "income" ? "income" : "net",
    deductionPct: raw.deductionPct ?? 0,
    dueDates: [1, 2, 3, 4].map((q) => raw.dueDates?.find((d) => d.q === q) ?? DEFAULT_TAX.dueDates[q - 1]!) as TaxSettings["dueDates"],
    reminderDaysBefore: raw.reminderDaysBefore ?? 14,
    enabled: raw.enabled !== false,
  };
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
