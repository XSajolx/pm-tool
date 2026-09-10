import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, contacts, deals } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { ProjectsService } from "../projects/projects.service.js";

export type DealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

export const STAGES: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];

/** Starting probability when a deal enters a stage; the user can override. */
const STAGE_PROBABILITY: Record<DealStage, number> = {
  lead: 10,
  qualified: 25,
  proposal: 50,
  negotiation: 75,
  won: 100,
  lost: 0,
};

export interface DealDto {
  title: string;
  companyId?: string | null;
  contactId?: string | null;
  value?: number;
  currency?: string;
  stage?: DealStage;
  probability?: number;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
  ownerId?: string | null;
}

@Injectable()
export class DealsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly projects: ProjectsService,
  ) {}

  async list(orgId: string) {
    const rows = await this.db.query.deals.findMany({
      where: and(eq(deals.organizationId, orgId), isNull(deals.archivedAt)),
      with: { company: true, contact: true, owner: true, project: true },
      orderBy: [asc(deals.position), asc(deals.createdAt)],
    });
    return rows.map(shape);
  }

  /** The pipeline: one column per stage with count, value and weighted value. */
  async board(orgId: string) {
    const all = await this.list(orgId);
    return STAGES.map((stage) => {
      const items = all.filter((d) => d.stage === stage);
      const value = items.reduce((a, d) => a + d.value, 0);
      const weighted = items.reduce((a, d) => a + (d.value * d.probability) / 100, 0);
      return { stage, count: items.length, value: round2(value), weighted: round2(weighted), deals: items };
    });
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, id), eq(deals.organizationId, orgId)),
      with: { company: true, contact: true, owner: true, project: true },
    });
    if (!row) throw new NotFoundException("Deal not found");
    return shape(row);
  }

  async create(orgId: string, userId: string, dto: DealDto) {
    await this.assertLinks(orgId, dto);
    const stage = dto.stage ?? "lead";
    const [maxPos] = await this.db
      .select({ m: sql<number>`coalesce(max(${deals.position}), 0)` })
      .from(deals)
      .where(and(eq(deals.organizationId, orgId), eq(deals.stage, stage)));

    const [row] = await this.db
      .insert(deals)
      .values({
        organizationId: orgId,
        createdById: userId,
        ownerId: dto.ownerId ?? userId,
        title: dto.title,
        companyId: dto.companyId ?? null,
        contactId: dto.contactId ?? null,
        value: dto.value ?? 0,
        currency: dto.currency ?? "USD",
        stage,
        probability: dto.probability ?? STAGE_PROBABILITY[stage],
        expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null,
        position: Number(maxPos?.m ?? 0) + 1,
      })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "deal", entityId: row!.id, action: "created" });
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: Partial<DealDto>) {
    const before = await this.get(orgId, id);
    await this.assertLinks(orgId, dto);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["title", "companyId", "contactId", "value", "currency", "probability", "lostReason", "ownerId"] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k];
    }
    if (dto.expectedCloseDate !== undefined) {
      patch.expectedCloseDate = dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null;
    }
    if (dto.stage && dto.stage !== before.stage) this.applyStage(patch, dto.stage, dto.probability);

    await this.db.update(deals).set(patch).where(and(eq(deals.id, id), eq(deals.organizationId, orgId)));

    const changes = this.activity.diff(
      before as unknown as Record<string, unknown>,
      dto as Record<string, unknown>,
      ["title", "value", "stage", "probability", "companyId", "contactId", "ownerId", "expectedCloseDate"],
    );
    if (changes.length) {
      const action = changes.some((c) => c.field === "stage")
        ? dto.stage === "won" ? "won" : dto.stage === "lost" ? "lost" : "stage_changed"
        : "updated";
      await this.activity.record({ orgId, actorId: userId, entityType: "deal", entityId: id, action, changes });
    }
    return this.get(orgId, id);
  }

  /** Kanban drop: new stage and position in one call. */
  async move(orgId: string, userId: string, id: string, stage: DealStage, position: number) {
    const before = await this.get(orgId, id);
    const patch: Record<string, unknown> = { position, updatedAt: new Date() };
    if (stage !== before.stage) this.applyStage(patch, stage);
    await this.db.update(deals).set(patch).where(and(eq(deals.id, id), eq(deals.organizationId, orgId)));
    if (stage !== before.stage) {
      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "deal",
        entityId: id,
        action: stage === "won" ? "won" : stage === "lost" ? "lost" : "stage_changed",
        changes: [{ field: "stage", from: before.stage, to: stage }],
      });
    }
    return this.get(orgId, id);
  }

  /**
   * Won deal → delivery project. The project inherits the client name and the
   * deal value as its budget; the deal keeps a link so both sides can navigate.
   */
  async convertToProject(orgId: string, userId: string, id: string) {
    const deal = await this.get(orgId, id);
    if (deal.project) throw new BadRequestException("This deal already has a project");

    const project = await this.projects.create(orgId, userId, {
      name: deal.title,
      clientName: deal.company?.name,
      budgetAmount: deal.value || undefined,
      currency: deal.currency,
    });

    const patch: Record<string, unknown> = { projectId: project.id, updatedAt: new Date() };
    if (deal.stage !== "won") this.applyStage(patch, "won");
    await this.db.update(deals).set(patch).where(eq(deals.id, id));

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "deal",
      entityId: id,
      action: "converted",
      changes: [{ field: "project", from: null, to: project.id }],
    });
    return this.get(orgId, id);
  }

  async archive(orgId: string, userId: string, id: string) {
    await this.get(orgId, id);
    await this.db.update(deals).set({ archivedAt: new Date() }).where(and(eq(deals.id, id), eq(deals.organizationId, orgId)));
    await this.activity.record({ orgId, actorId: userId, entityType: "deal", entityId: id, action: "archived" });
    return { id, archived: true };
  }

  /** Stage moves reset probability to the stage default unless one was given. */
  private applyStage(patch: Record<string, unknown>, stage: DealStage, probability?: number) {
    patch.stage = stage;
    patch.probability = probability ?? STAGE_PROBABILITY[stage];
    patch.closedAt = stage === "won" || stage === "lost" ? new Date() : null;
    if (stage !== "lost") patch.lostReason = null;
  }

  private async assertLinks(orgId: string, dto: Partial<DealDto>) {
    if (dto.companyId) {
      const c = await this.db.query.companies.findFirst({
        where: and(eq(companies.id, dto.companyId), eq(companies.organizationId, orgId)),
      });
      if (!c) throw new BadRequestException("Company not found in this organization");
    }
    if (dto.contactId) {
      const c = await this.db.query.contacts.findFirst({
        where: and(eq(contacts.id, dto.contactId), eq(contacts.organizationId, orgId)),
      });
      if (!c) throw new BadRequestException("Contact not found in this organization");
    }
  }
}

function shape(r: typeof deals.$inferSelect & {
  company: typeof companies.$inferSelect | null;
  contact: typeof contacts.$inferSelect | null;
  owner: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
}) {
  return {
    ...r,
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    contact: r.contact
      ? { id: r.contact.id, name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(" ") }
      : null,
    owner: r.owner ? { id: r.owner.id, name: r.owner.name } : null,
    project: r.project ? { id: r.project.id, name: r.project.name } : null,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
