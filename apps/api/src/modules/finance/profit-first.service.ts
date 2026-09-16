import { BadRequestException, Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { invoicePayments, invoices, organizations, profitMovements, type ProfitFirstConfig } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export type Bucket = "profit" | "owner_pay" | "tax" | "opex";
export const BUCKETS: Bucket[] = ["profit", "owner_pay", "tax", "opex"];

/** Mike Michalowicz's target percentages for a business under $250k real revenue. */
export const DEFAULT_CONFIG: ProfitFirstConfig = {
  enabled: false,
  buckets: [
    { key: "profit", label: "Profit", currentPct: 5, targetPct: 5 },
    { key: "owner_pay", label: "Owner's pay", currentPct: 50, targetPct: 50 },
    { key: "tax", label: "Tax", currentPct: 15, targetPct: 15 },
    { key: "opex", label: "Operating expenses", currentPct: 30, targetPct: 30 },
  ],
  startedAt: null,
};

export interface ConfigWrite {
  enabled?: boolean;
  buckets?: { key: Bucket; label?: string; currentPct?: number; targetPct?: number }[];
  startedAt?: string | null;
}

@Injectable()
export class ProfitFirstService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  /** Rows written before group ids existed group by their payment. */
  async onModuleInit() {
    try {
      await this.db.update(profitMovements).set({ groupId: sql`${profitMovements.paymentId}` }).where(and(isNull(profitMovements.groupId), sql`${profitMovements.paymentId} is not null`));
    } catch {
      /* table may not exist yet on a fresh install before migrations run */
    }
  }

  /* ---------------- config ---------------- */

  async config(orgId: string): Promise<ProfitFirstConfig> {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { profitFirst: true } });
    return normalise(org?.profitFirst ?? null);
  }

  async updateConfig(orgId: string, userId: string, dto: ConfigWrite) {
    const before = await this.config(orgId);
    const next: ProfitFirstConfig = { ...before, buckets: before.buckets.map((b) => ({ ...b })) };
    if (dto.enabled !== undefined) next.enabled = dto.enabled;
    if (dto.startedAt !== undefined) next.startedAt = dto.startedAt;
    if (dto.buckets) {
      for (const w of dto.buckets) {
        const b = next.buckets.find((x) => x.key === w.key);
        if (!b) continue;
        if (w.label !== undefined) b.label = w.label.trim().slice(0, 40) || b.label;
        if (w.currentPct !== undefined) b.currentPct = clampPct(w.currentPct);
        if (w.targetPct !== undefined) b.targetPct = clampPct(w.targetPct);
      }
    }
    const sum = round2(next.buckets.reduce((a, b) => a + b.currentPct, 0));
    if (Math.abs(sum - 100) > 0.01) throw new BadRequestException(`Current percentages must add up to 100 (they add up to ${sum})`);
    if (next.enabled && !next.startedAt) next.startedAt = new Date().toISOString().slice(0, 10);
    await this.db.update(organizations).set({ profitFirst: next, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "profit_first_updated", changes: next.buckets.map((b) => ({ field: b.key, from: String(before.buckets.find((x) => x.key === b.key)?.currentPct ?? ""), to: String(b.currentPct) })) });
    return next;
  }

  /* ---------------- overview ---------------- */

  async overview(orgId: string) {
    const cfg = await this.config(orgId);
    const rows = await this.db.query.profitMovements.findMany({
      where: eq(profitMovements.organizationId, orgId),
      with: { invoice: { columns: { id: true, number: true, title: true } }, createdBy: { columns: { id: true, name: true } } },
      orderBy: [desc(profitMovements.date), desc(profitMovements.createdAt)],
      limit: 2000,
    });
    const balances: Record<Bucket, { balance: number; allocated: number; distributed: number; untransferred: number }> = {
      profit: { balance: 0, allocated: 0, distributed: 0, untransferred: 0 },
      owner_pay: { balance: 0, allocated: 0, distributed: 0, untransferred: 0 },
      tax: { balance: 0, allocated: 0, distributed: 0, untransferred: 0 },
      opex: { balance: 0, allocated: 0, distributed: 0, untransferred: 0 },
    };
    for (const m of rows) {
      const b = balances[m.bucket];
      b.balance += m.amount;
      if (m.kind === "allocation") {
        b.allocated += m.amount;
        if (!m.transferredAt) b.untransferred += m.amount;
      } else if (m.kind === "distribution") b.distributed += -m.amount;
    }
    // Group allocation lines by their source payment so the history reads one row per income event.
    const groups = new Map<string, { id: string; date: Date; income: number; source: { invoiceId: string | null; number: string | null; title: string | null; note: string | null }; lines: { id: string; bucket: Bucket; pct: number | null; amount: number; transferredAt: Date | null }[]; transferred: boolean }>();
    const others: typeof rows = [];
    for (const m of rows) {
      if (m.kind !== "allocation") {
        others.push(m);
        continue;
      }
      const key = m.groupId ?? m.paymentId ?? m.id;
      let g = groups.get(key);
      if (!g) {
        g = { id: key, date: m.date, income: m.incomeAmount ?? 0, source: { invoiceId: m.invoiceId, number: m.invoice?.number ?? null, title: m.invoice?.title ?? null, note: m.note }, lines: [], transferred: true };
        groups.set(key, g);
      }
      g.lines.push({ id: m.id, bucket: m.bucket, pct: m.pct, amount: m.amount, transferredAt: m.transferredAt });
      if (!m.transferredAt) g.transferred = false;
    }
    const unallocated = cfg.enabled ? await this.unallocatedPayments(orgId, cfg) : { count: 0, amount: 0 };
    return {
      config: cfg,
      buckets: BUCKETS.map((k) => ({ key: k, label: cfg.buckets.find((b) => b.key === k)?.label ?? k, currentPct: cfg.buckets.find((b) => b.key === k)?.currentPct ?? 0, targetPct: cfg.buckets.find((b) => b.key === k)?.targetPct ?? 0, ...round(balances[k]) })),
      totals: { allocated: round2(BUCKETS.reduce((a, k) => a + balances[k].allocated, 0)), balance: round2(BUCKETS.reduce((a, k) => a + balances[k].balance, 0)), untransferred: round2(BUCKETS.reduce((a, k) => a + balances[k].untransferred, 0)) },
      allocations: [...groups.values()].map((g) => ({ ...g, income: round2(g.income), lines: g.lines.map((l) => ({ ...l, amount: round2(l.amount) })) })).slice(0, 200),
      movements: others.slice(0, 200).map((m) => ({ id: m.id, bucket: m.bucket, kind: m.kind, amount: round2(m.amount), date: m.date, note: m.note, createdBy: m.createdBy ? { id: m.createdBy.id, name: m.createdBy.name } : null })),
      unallocated,
    };
  }

  /* ---------------- allocations ---------------- */

  /** Called when income lands. No-op while Profit First is off or before its start date. */
  async allocatePayment(orgId: string, userId: string | null, payment: { id: string; invoiceId: string; amount: number; paidAt: Date }) {
    const cfg = await this.config(orgId);
    if (!cfg.enabled) return null;
    if (cfg.startedAt && payment.paidAt < new Date(cfg.startedAt)) return null;
    const existing = await this.db.query.profitMovements.findFirst({ where: eq(profitMovements.paymentId, payment.id), columns: { id: true } });
    if (existing) return null;
    await this.db.insert(profitMovements).values(splitLines(cfg, payment.amount).map((l) => ({ organizationId: orgId, groupId: payment.id, bucket: l.bucket, kind: "allocation" as const, amount: l.amount, paymentId: payment.id, invoiceId: payment.invoiceId, incomeAmount: payment.amount, pct: l.pct, date: payment.paidAt, createdById: userId })));
    return true;
  }

  /** Money that came in outside an invoice (a grant, an old receivable, interest). */
  async allocateManual(orgId: string, userId: string, dto: { amount: number; date?: string | null; note?: string | null }) {
    const cfg = await this.config(orgId);
    if (!cfg.enabled) throw new BadRequestException("Turn Profit First on first");
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException("Amount must be greater than zero");
    const date = dto.date ? new Date(dto.date) : new Date();
    const groupNote = dto.note?.trim() || "Other income";
    const lines = splitLines(cfg, amount);
    const groupId = randomUUID();
    await this.db.insert(profitMovements).values(lines.map((l) => ({ organizationId: orgId, groupId, bucket: l.bucket, kind: "allocation" as const, amount: l.amount, incomeAmount: amount, pct: l.pct, date, note: groupNote, createdById: userId })));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "profit_first_allocated", changes: [{ field: "amount", from: null, to: amount }] });
    return this.overview(orgId);
  }

  /** Split every recorded payment that has not been allocated yet (after enabling, or after the start date moved). */
  async backfill(orgId: string, userId: string) {
    const cfg = await this.config(orgId);
    if (!cfg.enabled) throw new BadRequestException("Turn Profit First on first");
    const pending = await this.pendingPayments(orgId, cfg);
    let n = 0;
    for (const p of pending) {
      if (await this.allocatePayment(orgId, userId, { id: p.id, invoiceId: p.invoiceId, amount: p.amount, paidAt: p.paidAt })) n++;
    }
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "profit_first_backfilled", changes: [{ field: "payments", from: null, to: String(n) }] });
    return { allocated: n, ...(await this.overview(orgId)) };
  }

  /** Removing a payment removes its allocation (as long as nothing was already transferred). */
  async unallocatePayment(orgId: string, paymentId: string) {
    const lines = await this.db.query.profitMovements.findMany({ where: and(eq(profitMovements.organizationId, orgId), eq(profitMovements.paymentId, paymentId)) });
    if (!lines.length) return;
    if (lines.some((l) => l.transferredAt)) throw new BadRequestException("This payment's Profit First allocation was already transferred to the bank — undo the transfer on the Profit First page first");
    await this.db.delete(profitMovements).where(and(eq(profitMovements.organizationId, orgId), eq(profitMovements.paymentId, paymentId)));
  }

  /** Mark one income event's four lines as moved to the real bank accounts (or unmark). */
  async setTransferred(orgId: string, userId: string, groupId: string, transferred: boolean) {
    const lines = await this.db.query.profitMovements.findMany({ where: and(eq(profitMovements.organizationId, orgId), eq(profitMovements.kind, "allocation"), sql`(${profitMovements.groupId} = ${groupId} or ${profitMovements.paymentId} = ${groupId} or ${profitMovements.id} = ${groupId})`) });
    if (!lines.length) throw new NotFoundException("Allocation not found");
    await this.db.update(profitMovements).set({ transferredAt: transferred ? new Date() : null, transferredById: transferred ? userId : null }).where(inArray(profitMovements.id, lines.map((l) => l.id)));
    return this.overview(orgId);
  }

  /** Manual "other income" splits can be taken back; invoice-backed ones follow the payment. */
  async removeManualAllocation(orgId: string, userId: string, groupId: string) {
    const lines = await this.db.query.profitMovements.findMany({ where: and(eq(profitMovements.organizationId, orgId), eq(profitMovements.kind, "allocation"), sql`(${profitMovements.groupId} = ${groupId} or ${profitMovements.paymentId} = ${groupId} or ${profitMovements.id} = ${groupId})`) });
    if (!lines.length) throw new NotFoundException("Allocation not found");
    if (lines.some((l) => l.paymentId)) throw new BadRequestException("This split came from an invoice payment — remove the payment instead");
    await this.db.delete(profitMovements).where(inArray(profitMovements.id, lines.map((l) => l.id)));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "profit_first_allocation_removed", changes: [{ field: "amount", from: lines[0]!.incomeAmount ?? null, to: null }] });
    return this.overview(orgId);
  }

  async markAllTransferred(orgId: string, userId: string) {
    await this.db.update(profitMovements).set({ transferredAt: new Date(), transferredById: userId }).where(and(eq(profitMovements.organizationId, orgId), eq(profitMovements.kind, "allocation"), isNull(profitMovements.transferredAt)));
    return this.overview(orgId);
  }

  /* ---------------- distributions & adjustments ---------------- */

  async distribute(orgId: string, userId: string, dto: { bucket: Bucket; amount: number; date?: string | null; note?: string | null; kind?: "distribution" | "adjustment"; direction?: "out" | "in" }) {
    if (!BUCKETS.includes(dto.bucket)) throw new BadRequestException("Unknown bucket");
    const amount = round2(Math.abs(dto.amount));
    if (!(amount > 0)) throw new BadRequestException("Amount must be greater than zero");
    const kind = dto.kind ?? "distribution";
    const signed = kind === "distribution" ? -amount : dto.direction === "in" ? amount : -amount;
    const [row] = await this.db.insert(profitMovements).values({ organizationId: orgId, bucket: dto.bucket, kind, amount: signed, date: dto.date ? new Date(dto.date) : new Date(), note: dto.note?.trim() || null, createdById: userId, transferredAt: new Date(), transferredById: userId }).returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: kind === "distribution" ? "profit_first_distributed" : "profit_first_adjusted", changes: [{ field: dto.bucket, from: null, to: signed }] });
    void row;
    return this.overview(orgId);
  }

  async removeMovement(orgId: string, userId: string, id: string) {
    const m = await this.db.query.profitMovements.findFirst({ where: and(eq(profitMovements.id, id), eq(profitMovements.organizationId, orgId)) });
    if (!m) throw new NotFoundException("Movement not found");
    if (m.kind === "allocation") throw new BadRequestException("Allocations follow the payment — remove the payment instead");
    await this.db.delete(profitMovements).where(eq(profitMovements.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "profit_first_movement_removed", changes: [{ field: m.bucket, from: m.amount, to: null }] });
    return this.overview(orgId);
  }

  /* ---------------- helpers ---------------- */

  private async pendingPayments(orgId: string, cfg: ProfitFirstConfig) {
    const rows = await this.db
      .select({ id: invoicePayments.id, invoiceId: invoicePayments.invoiceId, amount: invoicePayments.amount, paidAt: invoicePayments.paidAt })
      .from(invoicePayments)
      .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
      .leftJoin(profitMovements, eq(profitMovements.paymentId, invoicePayments.id))
      .where(and(eq(invoicePayments.organizationId, orgId), isNull(invoices.archivedAt), isNull(profitMovements.id), ...(cfg.startedAt ? [sql`${invoicePayments.paidAt} >= ${new Date(cfg.startedAt).toISOString()}::timestamptz`] : [])));
    return rows;
  }

  private async unallocatedPayments(orgId: string, cfg: ProfitFirstConfig) {
    const rows = await this.pendingPayments(orgId, cfg);
    return { count: rows.length, amount: round2(rows.reduce((a, r) => a + r.amount, 0)) };
  }
}

/** Percent split with the rounding remainder pushed onto the last bucket so the lines always sum to the income. */
export function splitLines(cfg: ProfitFirstConfig, amount: number) {
  const lines = BUCKETS.map((k) => {
    const pct = cfg.buckets.find((b) => b.key === k)?.currentPct ?? 0;
    return { bucket: k, pct, amount: round2((amount * pct) / 100) };
  });
  const diff = round2(amount - lines.reduce((a, l) => a + l.amount, 0));
  if (Math.abs(diff) >= 0.005) {
    const last = [...lines].reverse().find((l) => l.pct > 0) ?? lines[lines.length - 1]!;
    last.amount = round2(last.amount + diff);
  }
  return lines.filter((l) => l.pct > 0 || l.amount !== 0);
}

function normalise(raw: ProfitFirstConfig | null): ProfitFirstConfig {
  if (!raw) return { ...DEFAULT_CONFIG, buckets: DEFAULT_CONFIG.buckets.map((b) => ({ ...b })) };
  const buckets = BUCKETS.map((k) => {
    const d = DEFAULT_CONFIG.buckets.find((b) => b.key === k)!;
    const r = raw.buckets?.find((b) => b.key === k);
    return { key: k, label: r?.label ?? d.label, currentPct: r?.currentPct ?? d.currentPct, targetPct: r?.targetPct ?? d.targetPct };
  });
  return { enabled: Boolean(raw.enabled), buckets, startedAt: raw.startedAt ?? null };
}

function clampPct(n: number) {
  return Math.min(100, Math.max(0, round2(Number(n) || 0)));
}
function round(b: { balance: number; allocated: number; distributed: number; untransferred: number }) {
  return { balance: round2(b.balance), allocated: round2(b.allocated), distributed: round2(b.distributed), untransferred: round2(b.untransferred) };
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
