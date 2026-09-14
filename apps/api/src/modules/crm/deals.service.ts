import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, contacts, dealStages, deals } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { ProjectsService } from "../projects/projects.service.js";

export type DealStageKind = "open" | "won" | "lost";

/** What a fresh org's pipeline looks like (row 53: editable afterwards in Settings). */
export const DEFAULT_STAGES: { name: string; kind: DealStageKind; probability: number; color: string }[] = [
  { name: "Lead", kind: "open", probability: 10, color: "#94a3b8" },
  { name: "Qualified", kind: "open", probability: 25, color: "#0ea5e9" },
  { name: "Proposal", kind: "open", probability: 50, color: "#6366f1" },
  { name: "Negotiation", kind: "open", probability: 75, color: "#f59e0b" },
  { name: "Won", kind: "won", probability: 100, color: "#10b981" },
  { name: "Lost", kind: "lost", probability: 0, color: "#f87171" },
];

export interface DealDto {
  title: string;
  companyId?: string | null;
  contactId?: string | null;
  value?: number;
  currency?: string;
  stageId?: string;
  probability?: number;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
  ownerId?: string | null;
}

export interface StageDto {
  name?: string;
  kind?: DealStageKind;
  probability?: number;
  color?: string;
}

type StageRow = typeof dealStages.$inferSelect;

@Injectable()
export class DealsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly projects: ProjectsService,
  ) {}

  /* ---------------- stages (row 53) ---------------- */

  /** The org's stages in order; seeded with the defaults the first time anyone asks. */
  async stages(orgId: string): Promise<StageRow[]> {
    const rows = await this.db.query.dealStages.findMany({
      where: and(eq(dealStages.organizationId, orgId), isNull(dealStages.archivedAt)),
      orderBy: [asc(dealStages.position), asc(dealStages.createdAt)],
    });
    if (rows.length) return rows;
    await this.db.insert(dealStages).values(DEFAULT_STAGES.map((st, i) => ({ ...st, organizationId: orgId, position: i + 1 })));
    return this.stages(orgId);
  }

  async createStage(orgId: string, dto: StageDto & { name: string }) {
    const all = await this.stages(orgId);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException("Stage name is required");
    const kind = dto.kind ?? "open";
    // Terminal stages sit at the end; a new open stage goes before the first terminal one.
    const firstTerminal = all.find((s) => s.kind !== "open");
    const position = kind === "open" && firstTerminal ? firstTerminal.position - 0.5 : (all.at(-1)?.position ?? 0) + 1;
    const [row] = await this.db
      .insert(dealStages)
      .values({ organizationId: orgId, name, kind, probability: dto.probability ?? (kind === "won" ? 100 : kind === "lost" ? 0 : 10), color: dto.color ?? "#6366f1", position })
      .returning();
    return row!;
  }

  async updateStage(orgId: string, id: string, dto: StageDto) {
    const stage = await this.stage(orgId, id);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw new BadRequestException("Stage name is required");
      patch.name = dto.name.trim();
    }
    if (dto.kind !== undefined && dto.kind !== stage.kind) {
      if (stage.kind !== "open") {
        const others = (await this.stages(orgId)).filter((s) => s.id !== id && s.kind === stage.kind);
        if (!others.length) throw new BadRequestException(`Keep at least one ${stage.kind} stage`);
      }
      patch.kind = dto.kind;
    }
    if (dto.probability !== undefined) patch.probability = Math.max(0, Math.min(100, Math.round(dto.probability)));
    if (dto.color !== undefined) patch.color = dto.color;
    const [row] = await this.db.update(dealStages).set(patch).where(eq(dealStages.id, id)).returning();
    return row!;
  }

  async reorderStages(orgId: string, ids: string[]) {
    const all = await this.stages(orgId);
    const known = new Set(all.map((s) => s.id));
    const ordered = ids.filter((id) => known.has(id));
    for (const s of all) if (!ordered.includes(s.id)) ordered.push(s.id);
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < ordered.length; i++) {
        await tx.update(dealStages).set({ position: i + 1 }).where(and(eq(dealStages.id, ordered[i]!), eq(dealStages.organizationId, orgId)));
      }
    });
    return this.stages(orgId);
  }

  /** Remove a stage; its deals move to `moveToId` (or the first open stage). */
  async deleteStage(orgId: string, id: string, moveToId?: string) {
    const stage = await this.stage(orgId, id);
    const all = await this.stages(orgId);
    if (all.length <= 2) throw new BadRequestException("A pipeline needs at least two stages");
    if (stage.kind !== "open" && !all.some((s) => s.id !== id && s.kind === stage.kind)) {
      throw new BadRequestException(`Keep at least one ${stage.kind} stage`);
    }
    const target = moveToId ? all.find((s) => s.id === moveToId && s.id !== id) : all.find((s) => s.id !== id && s.kind === "open");
    if (!target) throw new BadRequestException("Pick a stage to move the deals to");
    await this.db.update(deals).set({ stageId: target.id, updatedAt: new Date() }).where(and(eq(deals.stageId, id), eq(deals.organizationId, orgId)));
    await this.db.update(dealStages).set({ archivedAt: new Date() }).where(eq(dealStages.id, id));
    return this.stages(orgId);
  }

  private async stage(orgId: string, id: string) {
    const row = await this.db.query.dealStages.findFirst({ where: and(eq(dealStages.id, id), eq(dealStages.organizationId, orgId), isNull(dealStages.archivedAt)) });
    if (!row) throw new NotFoundException("Stage not found");
    return row;
  }

  /* ---------------- deals ---------------- */

  async list(orgId: string) {
    await this.stages(orgId);
    const rows = await this.db.query.deals.findMany({
      where: and(eq(deals.organizationId, orgId), isNull(deals.archivedAt)),
      with: { company: true, contact: true, owner: true, project: true, stage: true },
      orderBy: [asc(deals.position), asc(deals.createdAt)],
    });
    return rows.map(shape);
  }

  /** The pipeline: one column per stage with count, value and weighted value. */
  async board(orgId: string) {
    const [stages, all] = await Promise.all([this.stages(orgId), this.list(orgId)]);
    const firstOpen = stages.find((s) => s.kind === "open") ?? stages[0]!;
    return stages.map((st) => {
      const items = all.filter((d) => (d.stageId ?? firstOpen.id) === st.id);
      const value = items.reduce((a, d) => a + d.value, 0);
      const weighted = items.reduce((a, d) => a + (d.value * d.probability) / 100, 0);
      return { stage: shapeStage(st), count: items.length, value: round2(value), weighted: round2(weighted), deals: items };
    });
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, id), eq(deals.organizationId, orgId)),
      with: { company: true, contact: true, owner: true, project: true, stage: true },
    });
    if (!row) throw new NotFoundException("Deal not found");
    return shape(row);
  }

  async create(orgId: string, userId: string, dto: DealDto) {
    await this.assertLinks(orgId, dto);
    const stages = await this.stages(orgId);
    const stage = (dto.stageId ? stages.find((s) => s.id === dto.stageId) : undefined) ?? stages.find((s) => s.kind === "open") ?? stages[0]!;
    const [maxPos] = await this.db
      .select({ m: sql<number>`coalesce(max(${deals.position}), 0)` })
      .from(deals)
      .where(and(eq(deals.organizationId, orgId), eq(deals.stageId, stage.id)));

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
        stageId: stage.id,
        probability: dto.probability ?? stage.probability,
        closedAt: stage.kind === "open" ? null : new Date(),
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
    let moved: StageRow | null = null;
    if (dto.stageId && dto.stageId !== before.stageId) {
      moved = await this.stage(orgId, dto.stageId);
      this.applyStage(patch, moved, dto.probability);
    }

    await this.db.update(deals).set(patch).where(and(eq(deals.id, id), eq(deals.organizationId, orgId)));

    const changes = this.activity.diff(
      { ...before, stage: before.stage?.name ?? null } as unknown as Record<string, unknown>,
      { ...dto, stage: moved?.name } as Record<string, unknown>,
      ["title", "value", "stage", "probability", "companyId", "contactId", "ownerId", "expectedCloseDate"],
    );
    if (changes.length) {
      const action = moved ? (moved.kind === "won" ? "won" : moved.kind === "lost" ? "lost" : "stage_changed") : "updated";
      await this.activity.record({ orgId, actorId: userId, entityType: "deal", entityId: id, action, changes });
    }
    return this.get(orgId, id);
  }

  /** Kanban drop: new stage and position in one call. */
  async move(orgId: string, userId: string, id: string, stageId: string, position: number) {
    const before = await this.get(orgId, id);
    const patch: Record<string, unknown> = { position, updatedAt: new Date() };
    const stage = await this.stage(orgId, stageId);
    const changed = stageId !== before.stageId;
    if (changed) this.applyStage(patch, stage);
    await this.db.update(deals).set(patch).where(and(eq(deals.id, id), eq(deals.organizationId, orgId)));
    if (changed) {
      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "deal",
        entityId: id,
        action: stage.kind === "won" ? "won" : stage.kind === "lost" ? "lost" : "stage_changed",
        changes: [{ field: "stage", from: before.stage?.name ?? null, to: stage.name }],
      });
    }
    return this.get(orgId, id);
  }

  /**
   * Won deal → delivery project. The project inherits the client and the deal
   * value as its budget; the deal keeps a link so both sides can navigate.
   */
  async convertToProject(orgId: string, userId: string, id: string) {
    const deal = await this.get(orgId, id);
    if (deal.project) throw new BadRequestException("This deal already has a project");

    const project = await this.projects.create(orgId, userId, {
      name: deal.title,
      clientName: deal.company?.name,
      companyId: deal.company?.id ?? null,
      budgetAmount: deal.value || undefined,
      currency: deal.currency,
    });

    const patch: Record<string, unknown> = { projectId: project.id, updatedAt: new Date() };
    if (deal.stage?.kind !== "won") {
      const won = (await this.stages(orgId)).find((s) => s.kind === "won");
      if (won) this.applyStage(patch, won);
    }
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
  private applyStage(patch: Record<string, unknown>, stage: StageRow, probability?: number) {
    patch.stageId = stage.id;
    patch.probability = probability ?? stage.probability;
    patch.closedAt = stage.kind === "open" ? null : new Date();
    if (stage.kind !== "lost") patch.lostReason = null;
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

export function shapeStage(s: StageRow) {
  return { id: s.id, name: s.name, kind: s.kind, color: s.color, probability: s.probability, position: s.position };
}

function shape(r: typeof deals.$inferSelect & {
  company: typeof companies.$inferSelect | null;
  contact: typeof contacts.$inferSelect | null;
  owner: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  stage: StageRow | null;
}) {
  return {
    ...r,
    stage: r.stage ? { id: r.stage.id, name: r.stage.name, kind: r.stage.kind, color: r.stage.color } : null,
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

/** Used by companies.service for open/won roll-ups. */
export { inArray as _inArray };
