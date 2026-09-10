import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, contacts, deals, estimateItems, estimates } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export type EstimateStatus = "draft" | "sent" | "accepted" | "declined" | "expired";

export interface EstimateItemDto {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface EstimateDto {
  title: string;
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  currency?: string;
  issueDate?: string | null;
  validUntil?: string | null;
  notes?: string | null;
  taxRate?: number;
  items?: EstimateItemDto[];
}

/** Legal moves. Draft is the only editable state; accepted/declined are final. */
const TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
  draft: ["sent"],
  sent: ["accepted", "declined", "expired", "draft"],
  accepted: [],
  declined: ["draft"],
  expired: ["draft"],
};

@Injectable()
export class EstimatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  async list(orgId: string, opts: { companyId?: string; dealId?: string } = {}) {
    const rows = await this.db.query.estimates.findMany({
      where: and(
        eq(estimates.organizationId, orgId),
        isNull(estimates.archivedAt),
        ...(opts.companyId ? [eq(estimates.companyId, opts.companyId)] : []),
        ...(opts.dealId ? [eq(estimates.dealId, opts.dealId)] : []),
      ),
      with: { company: true, contact: true, deal: true },
      orderBy: desc(estimates.createdAt),
    });
    return rows.map((r) => shape(r, []));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.estimates.findFirst({
      where: and(eq(estimates.id, id), eq(estimates.organizationId, orgId)),
      with: { company: true, contact: true, deal: true, items: { orderBy: asc(estimateItems.position) } },
    });
    if (!row) throw new NotFoundException("Estimate not found");
    return shape(row, row.items);
  }

  async create(orgId: string, userId: string, dto: EstimateDto) {
    await this.assertLinks(orgId, dto);
    const items = dto.items ?? [];
    const totals = computeTotals(items, dto.taxRate ?? 0);

    // Sequential number per org. The unique index is the real guarantee; the
    // retry covers two people creating at the same instant.
    for (let attempt = 0; attempt < 3; attempt++) {
      const number = await this.nextNumber(orgId);
      try {
        const id = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(estimates)
            .values({
              organizationId: orgId,
              createdById: userId,
              number,
              title: dto.title,
              companyId: dto.companyId ?? null,
              contactId: dto.contactId ?? null,
              dealId: dto.dealId ?? null,
              currency: dto.currency ?? "USD",
              issueDate: dto.issueDate ? new Date(dto.issueDate) : new Date(),
              validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
              notes: dto.notes ?? null,
              taxRate: dto.taxRate ?? 0,
              ...totals,
            })
            .returning();
          if (items.length) await tx.insert(estimateItems).values(itemRows(orgId, row!.id, items));
          return row!.id;
        });
        await this.activity.record({ orgId, actorId: userId, entityType: "estimate", entityId: id, action: "created" });
        return this.get(orgId, id);
      } catch (err) {
        if (!String((err as Error).message).includes("estimates_org_number_uq") || attempt === 2) throw err;
      }
    }
    throw new BadRequestException("Could not allocate an estimate number");
  }

  /** Header and line items are replaced together; totals are recomputed here, never trusted from the client. */
  async update(orgId: string, userId: string, id: string, dto: Partial<EstimateDto>) {
    const before = await this.get(orgId, id);
    if (before.status !== "draft") {
      throw new BadRequestException("Only draft estimates can be edited — move it back to draft first");
    }
    await this.assertLinks(orgId, dto);

    const items = dto.items ?? before.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice }));
    const taxRate = dto.taxRate ?? before.taxRate;
    const totals = computeTotals(items, taxRate);

    await this.db.transaction(async (tx) => {
      const patch: Record<string, unknown> = { ...totals, taxRate, updatedAt: new Date() };
      for (const k of ["title", "companyId", "contactId", "dealId", "currency", "notes"] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }
      if (dto.issueDate !== undefined) patch.issueDate = dto.issueDate ? new Date(dto.issueDate) : null;
      if (dto.validUntil !== undefined) patch.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
      await tx.update(estimates).set(patch).where(eq(estimates.id, id));

      if (dto.items) {
        await tx.delete(estimateItems).where(eq(estimateItems.estimateId, id));
        if (items.length) await tx.insert(estimateItems).values(itemRows(orgId, id, items));
      }
    });

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "estimate",
      entityId: id,
      action: "updated",
      changes: [{ field: "total", from: before.total, to: totals.total }],
    });
    return this.get(orgId, id);
  }

  async setStatus(orgId: string, userId: string, id: string, status: EstimateStatus) {
    const before = await this.get(orgId, id);
    if (!TRANSITIONS[before.status].includes(status)) {
      throw new BadRequestException(`Cannot move an estimate from ${before.status} to ${status}`);
    }
    const patch: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === "sent") patch.sentAt = new Date();
    if (status === "accepted") patch.acceptedAt = new Date();
    await this.db.update(estimates).set(patch).where(eq(estimates.id, id));
    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "estimate",
      entityId: id,
      action: status,
      changes: [{ field: "status", from: before.status, to: status }],
    });
    return this.get(orgId, id);
  }

  async archive(orgId: string, userId: string, id: string) {
    await this.get(orgId, id);
    await this.db.update(estimates).set({ archivedAt: new Date() }).where(eq(estimates.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "estimate", entityId: id, action: "archived" });
    return { id, archived: true };
  }

  private async nextNumber(orgId: string) {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(estimates)
      .where(eq(estimates.organizationId, orgId));
    return `EST-${String((row?.n ?? 0) + 1).padStart(4, "0")}`;
  }

  private async assertLinks(orgId: string, dto: Partial<EstimateDto>) {
    const checks: [string | null | undefined, () => Promise<unknown>, string][] = [
      [dto.companyId, () => this.db.query.companies.findFirst({ where: and(eq(companies.id, dto.companyId!), eq(companies.organizationId, orgId)) }), "Company"],
      [dto.contactId, () => this.db.query.contacts.findFirst({ where: and(eq(contacts.id, dto.contactId!), eq(contacts.organizationId, orgId)) }), "Contact"],
      [dto.dealId, () => this.db.query.deals.findFirst({ where: and(eq(deals.id, dto.dealId!), eq(deals.organizationId, orgId)) }), "Deal"],
    ];
    for (const [id, find, label] of checks) {
      if (id && !(await find())) throw new BadRequestException(`${label} not found in this organization`);
    }
  }
}

function computeTotals(items: EstimateItemDto[], taxRate: number) {
  const subtotal = round2(items.reduce((a, i) => a + i.quantity * i.unitPrice, 0));
  const taxAmount = round2(subtotal * (taxRate / 100));
  return { subtotal, taxAmount, total: round2(subtotal + taxAmount) };
}

function itemRows(orgId: string, estimateId: string, items: EstimateItemDto[]) {
  return items.map((i, idx) => ({
    organizationId: orgId,
    estimateId,
    description: i.description,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    amount: round2(i.quantity * i.unitPrice),
    position: idx + 1,
  }));
}

function shape(
  r: typeof estimates.$inferSelect & {
    company: typeof companies.$inferSelect | null;
    contact: typeof contacts.$inferSelect | null;
    deal: typeof deals.$inferSelect | null;
  },
  items: (typeof estimateItems.$inferSelect)[],
) {
  return {
    ...r,
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    contact: r.contact
      ? { id: r.contact.id, name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(" "), email: r.contact.email }
      : null,
    deal: r.deal ? { id: r.deal.id, title: r.deal.title } : null,
    items: items.map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      amount: i.amount,
    })),
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
