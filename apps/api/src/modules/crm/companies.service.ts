import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, contacts, dealStages, deals, projects } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export interface CompanyDto {
  name: string;
  website?: string;
  industry?: string;
  email?: string;
  phone?: string;
  address?: string;
  ownerId?: string | null;
}

const TRACKED = ["name", "website", "industry", "email", "phone", "ownerId"];

@Injectable()
export class CompaniesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  /** Companies with contact / open-deal counts, in two grouped queries. */
  async list(orgId: string, q?: string) {
    const rows = await this.db.query.companies.findMany({
      where: and(
        eq(companies.organizationId, orgId),
        isNull(companies.archivedAt),
        ...(q ? [ilike(companies.name, `%${q}%`)] : []),
      ),
      with: { owner: true },
      orderBy: asc(companies.name),
    });
    if (!rows.length) return [];

    const ids = rows.map((r) => r.id);
    const [contactCounts, dealStats] = await Promise.all([
      this.db
        .select({ companyId: contacts.companyId, n: sql<number>`count(*)::int` })
        .from(contacts)
        .where(and(inArray(contacts.companyId, ids), isNull(contacts.archivedAt)))
        .groupBy(contacts.companyId),
      this.db
        .select({
          companyId: deals.companyId,
          open: sql<number>`count(*) filter (where coalesce(${dealStages.kind}, 'open') = 'open')::int`,
          wonValue: sql<number>`coalesce(sum(${deals.value}) filter (where ${dealStages.kind} = 'won'), 0)`,
        })
        .from(deals)
        .leftJoin(dealStages, eq(deals.stageId, dealStages.id))
        .where(and(inArray(deals.companyId, ids), isNull(deals.archivedAt)))
        .groupBy(deals.companyId),
    ]);
    const cc = new Map(contactCounts.map((c) => [c.companyId, c.n]));
    const ds = new Map(dealStats.map((d) => [d.companyId, d]));

    return rows.map((c) => ({
      ...c,
      owner: c.owner ? { id: c.owner.id, name: c.owner.name } : null,
      contactCount: cc.get(c.id) ?? 0,
      openDeals: ds.get(c.id)?.open ?? 0,
      wonValue: Number(ds.get(c.id)?.wonValue ?? 0),
    }));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.companies.findFirst({
      where: and(eq(companies.id, id), eq(companies.organizationId, orgId)),
      with: {
        owner: true,
        contacts: { where: isNull(contacts.archivedAt), orderBy: asc(contacts.firstName) },
        deals: { where: isNull(deals.archivedAt), with: { stage: { columns: { id: true, name: true, kind: true, color: true } } } },
      },
    });
    if (!row) throw new NotFoundException("Company not found");
    // Row 51: everything about a client in one place — its projects too.
    const projectRows = await this.db.query.projects.findMany({
      where: and(eq(projects.companyId, id), eq(projects.organizationId, orgId), isNull(projects.archivedAt)),
      columns: { id: true, name: true, color: true, status: true, startDate: true, endDate: true, budgetAmount: true, currency: true },
      with: { lead: { columns: { id: true, name: true } } },
      orderBy: (p, { desc }) => [desc(p.createdAt)],
    });
    return { ...row, owner: row.owner ? { id: row.owner.id, name: row.owner.name } : null, projects: projectRows };
  }

  async create(orgId: string, userId: string, dto: CompanyDto) {
    const [row] = await this.db
      .insert(companies)
      .values({ organizationId: orgId, createdById: userId, ...dto, ownerId: dto.ownerId ?? userId })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "company", entityId: row!.id, action: "created" });
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: Partial<CompanyDto>) {
    const before = await this.get(orgId, id);
    const [row] = await this.db
      .update(companies)
      .set({ ...dto, updatedAt: new Date() })
      .where(and(eq(companies.id, id), eq(companies.organizationId, orgId)))
      .returning();
    const changes = this.activity.diff(before as unknown as Record<string, unknown>, dto as Record<string, unknown>, TRACKED);
    if (changes.length) {
      await this.activity.record({ orgId, actorId: userId, entityType: "company", entityId: id, action: "updated", changes });
    }
    return { ...row!, owner: before.owner };
  }

  async archive(orgId: string, userId: string, id: string) {
    await this.get(orgId, id);
    await this.db
      .update(companies)
      .set({ archivedAt: new Date() })
      .where(and(eq(companies.id, id), eq(companies.organizationId, orgId)));
    await this.activity.record({ orgId, actorId: userId, entityType: "company", entityId: id, action: "archived" });
    return { id, archived: true };
  }
}
