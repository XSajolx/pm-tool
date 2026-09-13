import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { projectStages, projects, stageTemplates, statuses, tasks } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export type StageStatus = "not_started" | "active" | "completed";

/** The sequence every org starts with; seeded as the default template on first read. */
export const DEFAULT_STAGE_SEQUENCE = ["Discovery", "Design", "Build", "QA", "Launch"];

@Injectable()
export class StagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  /* ---------------- stages on a project ---------------- */

  async listForProject(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    const rows = await this.db.query.projectStages.findMany({
      where: and(eq(projectStages.projectId, projectId), eq(projectStages.organizationId, orgId)),
      orderBy: [asc(projectStages.position), asc(projectStages.createdAt)],
    });
    const progress = await this.progressFor(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, progress: progress.get(r.id) ?? { total: 0, done: 0 } }));
  }

  async create(orgId: string, userId: string, projectId: string, name: string) {
    await this.assertProject(orgId, projectId);
    const [max] = await this.db
      .select({ m: sql<number>`coalesce(max(${projectStages.position}), 0)` })
      .from(projectStages)
      .where(eq(projectStages.projectId, projectId));
    const [row] = await this.db
      .insert(projectStages)
      .values({ organizationId: orgId, projectId, name: name.trim(), position: Number(max?.m ?? 0) + 1 })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "stage", entityId: row!.id, action: "created" });
    return { ...row!, progress: { total: 0, done: 0 } };
  }

  /** Append a template's stages to a project (used at creation and from the project page). */
  async applyTemplate(orgId: string, userId: string, projectId: string, templateId: string) {
    const template = await this.db.query.stageTemplates.findFirst({
      where: and(eq(stageTemplates.id, templateId), eq(stageTemplates.organizationId, orgId)),
    });
    if (!template) throw new NotFoundException("Stage template not found");
    return this.appendStages(orgId, userId, projectId, template.stages);
  }

  async appendStages(orgId: string, userId: string, projectId: string, names: string[]) {
    await this.assertProject(orgId, projectId);
    const [max] = await this.db
      .select({ m: sql<number>`coalesce(max(${projectStages.position}), 0)` })
      .from(projectStages)
      .where(eq(projectStages.projectId, projectId));
    let position = Number(max?.m ?? 0);
    const clean = names.map((n) => n.trim()).filter(Boolean);
    if (!clean.length) return this.listForProject(orgId, projectId);
    const rows = await this.db
      .insert(projectStages)
      .values(clean.map((name) => ({ organizationId: orgId, projectId, name, position: ++position })))
      .returning();
    for (const row of rows) {
      await this.activity.record({ orgId, actorId: userId, entityType: "stage", entityId: row.id, action: "created" });
    }
    return this.listForProject(orgId, projectId);
  }

  async reorder(orgId: string, projectId: string, ids: string[]) {
    await this.assertProject(orgId, projectId);
    await this.db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx
          .update(projectStages)
          .set({ position: i + 1 })
          .where(and(eq(projectStages.id, id), eq(projectStages.projectId, projectId)));
      }
    });
    return this.listForProject(orgId, projectId);
  }

  /**
   * Rename or move a stage through its lifecycle. Reopening a completed stage
   * needs a short note so the timeline explains why.
   */
  async update(
    orgId: string,
    userId: string,
    id: string,
    dto: { name?: string; status?: StageStatus; note?: string },
  ) {
    const stage = await this.db.query.projectStages.findFirst({
      where: and(eq(projectStages.id, id), eq(projectStages.organizationId, orgId)),
    });
    if (!stage) throw new NotFoundException("Stage not found");

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    let action: string | null = null;
    if (dto.status && dto.status !== stage.status) {
      const now = new Date();
      if (dto.status === "active") {
        if (stage.status === "completed") {
          if (!dto.note?.trim()) throw new BadRequestException("Add a short note explaining why the stage is reopened");
          action = "reopened";
          patch.completedAt = null;
        } else {
          action = "started";
          patch.startedAt = stage.startedAt ?? now;
        }
      } else if (dto.status === "completed") {
        action = "completed";
        patch.completedAt = now;
        patch.startedAt = stage.startedAt ?? now;
      } else {
        action = "reset";
        patch.startedAt = null;
        patch.completedAt = null;
      }
      patch.status = dto.status;
    }

    const [row] = await this.db.update(projectStages).set(patch).where(eq(projectStages.id, id)).returning();

    if (dto.name !== undefined && dto.name.trim() !== stage.name) {
      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "stage",
        entityId: id,
        action: "renamed",
        changes: [{ field: "name", from: stage.name, to: dto.name.trim() }],
      });
    }
    if (action) {
      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "stage",
        entityId: id,
        action,
        changes: dto.note?.trim() ? [{ field: "note", from: null, to: dto.note.trim() }] : undefined,
      });
    }
    const progress = await this.progressFor([id]);
    return { ...row!, progress: progress.get(id) ?? { total: 0, done: 0 } };
  }

  async remove(orgId: string, userId: string, id: string) {
    const stage = await this.db.query.projectStages.findFirst({
      where: and(eq(projectStages.id, id), eq(projectStages.organizationId, orgId)),
    });
    if (!stage) throw new NotFoundException("Stage not found");
    // tasks.stage_id is ON DELETE SET NULL, so filed tasks simply become unstaged.
    await this.db.delete(projectStages).where(eq(projectStages.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "stage", entityId: id, action: "deleted" });
    return { id, deleted: true };
  }

  /** Timeline of a stage: started / completed / reopened (with notes). */
  activityFor(orgId: string, id: string) {
    return this.activity.listFor(orgId, "stage", id);
  }

  /** Stages of the project that owns `spaceId` (for task pickers). */
  async listForSpace(orgId: string, spaceId: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.spaceId, spaceId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) return [];
    return this.listForProject(orgId, project.id);
  }

  /* ---------------- templates (org-wide) ---------------- */

  async listTemplates(orgId: string) {
    const rows = await this.db.query.stageTemplates.findMany({
      where: and(eq(stageTemplates.organizationId, orgId), isNull(stageTemplates.archivedAt)),
      orderBy: [desc(stageTemplates.isDefault), asc(stageTemplates.name)],
    });
    if (rows.length) return rows;
    // First use: seed the standard sequence as the default so new projects get it.
    const [seeded] = await this.db
      .insert(stageTemplates)
      .values({ organizationId: orgId, name: "Standard delivery", stages: DEFAULT_STAGE_SEQUENCE, isDefault: true })
      .returning();
    return [seeded!];
  }

  async createTemplate(orgId: string, dto: { name: string; stages: string[]; isDefault?: boolean }) {
    if (dto.isDefault) await this.clearDefault(orgId);
    const [row] = await this.db
      .insert(stageTemplates)
      .values({
        organizationId: orgId,
        name: dto.name.trim(),
        stages: dto.stages.map((s) => s.trim()).filter(Boolean),
        isDefault: dto.isDefault ?? false,
      })
      .returning();
    return row!;
  }

  async updateTemplate(orgId: string, id: string, dto: { name?: string; stages?: string[]; isDefault?: boolean }) {
    const existing = await this.db.query.stageTemplates.findFirst({
      where: and(eq(stageTemplates.id, id), eq(stageTemplates.organizationId, orgId)),
    });
    if (!existing) throw new NotFoundException("Stage template not found");
    if (dto.isDefault) await this.clearDefault(orgId);
    const [row] = await this.db
      .update(stageTemplates)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.stages !== undefined ? { stages: dto.stages.map((s) => s.trim()).filter(Boolean) } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        updatedAt: new Date(),
      })
      .where(eq(stageTemplates.id, id))
      .returning();
    return row!;
  }

  async removeTemplate(orgId: string, id: string) {
    const [row] = await this.db
      .update(stageTemplates)
      .set({ archivedAt: new Date(), isDefault: false })
      .where(and(eq(stageTemplates.id, id), eq(stageTemplates.organizationId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Stage template not found");
    return { id, deleted: true };
  }

  /** The default template's stage names, or the built-in sequence when none is set. */
  async defaultStageNames(orgId: string) {
    const templates = await this.listTemplates(orgId);
    return templates.find((t) => t.isDefault)?.stages ?? [];
  }

  /* ---------------- helpers ---------------- */

  private async clearDefault(orgId: string) {
    await this.db.update(stageTemplates).set({ isDefault: false }).where(eq(stageTemplates.organizationId, orgId));
  }

  private async assertProject(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");
  }

  /** Task counts per stage; "done" follows the status category so custom names count. */
  private async progressFor(stageIds: string[]) {
    const out = new Map<string, { total: number; done: number }>();
    if (!stageIds.length) return out;
    const rows = await this.db
      .select({
        stageId: tasks.stageId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${statuses.category} = 'done')::int`,
      })
      .from(tasks)
      .leftJoin(statuses, eq(statuses.id, tasks.statusId))
      .where(and(inArray(tasks.stageId, stageIds), isNull(tasks.archivedAt)))
      .groupBy(tasks.stageId);
    for (const r of rows) if (r.stageId) out.set(r.stageId, { total: r.total, done: r.done });
    return out;
  }
}
