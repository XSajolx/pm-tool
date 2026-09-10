import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { intakeItems, intakes, lists, statuses, tasks } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export type IntakeDecision = "accepted" | "rejected" | "snoozed" | "duplicate";

export interface SubmitDto {
  intakeId: string;
  title: string;
  description?: string;
  source?: "in_app" | "email" | "form";
  sourceEmail?: string;
}

/**
 * The triage queue. Submissions become real task rows immediately — that's what
 * lets them be commented on and linked before anyone decides their fate — but
 * they carry an `intake_items` row in `pending`, and the task lists filter those
 * out until someone accepts. Accepting is therefore just a status flip plus a
 * move into the target list, not a copy.
 */
@Injectable()
export class IntakeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  async listForSpace(orgId: string, spaceId: string) {
    return this.db
      .select()
      .from(intakes)
      .where(and(eq(intakes.organizationId, orgId), eq(intakes.spaceId, spaceId)));
  }

  /** Creates the queue for a space if it doesn't have one yet. */
  async ensureForSpace(orgId: string, spaceId: string, targetListId?: string) {
    const existing = await this.db.query.intakes.findFirst({
      where: and(eq(intakes.organizationId, orgId), eq(intakes.spaceId, spaceId)),
    });
    if (existing) return existing;

    // Default the landing spot to the first list in the space.
    const fallback =
      targetListId ??
      (
        await this.db.query.lists.findFirst({
          where: and(eq(lists.organizationId, orgId), eq(lists.spaceId, spaceId)),
        })
      )?.id;

    const [row] = await this.db
      .insert(intakes)
      .values({
        organizationId: orgId,
        spaceId,
        name: "Intake",
        isDefault: true,
        targetListId: fallback ?? null,
      })
      .returning();
    return row!;
  }

  /** The queue itself, newest first, with the underlying task joined in. */
  async items(orgId: string, intakeId: string, status?: string) {
    const where = [
      eq(intakeItems.organizationId, orgId),
      eq(intakeItems.intakeId, intakeId),
    ];
    if (status) where.push(eq(intakeItems.status, status as IntakeDecision | "pending"));

    const rows = await this.db
      .select()
      .from(intakeItems)
      .where(and(...where))
      .orderBy(desc(intakeItems.createdAt));

    if (!rows.length) return [];

    const related = await this.db.query.tasks.findMany({
      where: inArray(
        tasks.id,
        rows.map((r) => r.taskId),
      ),
      with: { status: true },
    });
    const byId = new Map(related.map((t) => [t.id, t]));

    return rows.map((r) => ({ ...r, task: byId.get(r.taskId) ?? null }));
  }

  async submit(orgId: string, userId: string | null, dto: SubmitDto) {
    const intake = await this.db.query.intakes.findFirst({
      where: and(eq(intakes.id, dto.intakeId), eq(intakes.organizationId, orgId)),
    });
    if (!intake) throw new NotFoundException("Intake not found");
    if (!intake.targetListId) {
      throw new BadRequestException("This intake has no target list configured");
    }

    const [task] = await this.db
      .insert(tasks)
      .values({
        organizationId: orgId,
        listId: intake.targetListId,
        title: dto.title,
        description: dto.description,
        createdById: userId,
        // Archived until triaged, so it stays out of the normal lists.
        archivedAt: new Date(),
      })
      .returning();

    const [item] = await this.db
      .insert(intakeItems)
      .values({
        organizationId: orgId,
        intakeId: intake.id,
        taskId: task!.id,
        source: dto.source ?? "in_app",
        sourceEmail: dto.sourceEmail ?? null,
      })
      .returning();

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "intake_item",
      entityId: item!.id,
      action: "submitted",
    });

    return { ...item!, task };
  }

  /**
   * Triage. Accepting un-archives the task so it joins the normal lists; every
   * other outcome leaves it archived but keeps the record, so a rejected idea is
   * still searchable rather than deleted.
   */
  async decide(
    orgId: string,
    userId: string,
    itemId: string,
    decision: IntakeDecision,
    opts: { snoozedTill?: string; duplicateToTaskId?: string; statusId?: string } = {},
  ) {
    const item = await this.db.query.intakeItems.findFirst({
      where: and(eq(intakeItems.id, itemId), eq(intakeItems.organizationId, orgId)),
    });
    if (!item) throw new NotFoundException("Intake item not found");

    if (decision === "snoozed" && !opts.snoozedTill) {
      throw new BadRequestException("snoozedTill is required when snoozing");
    }
    if (decision === "duplicate" && !opts.duplicateToTaskId) {
      throw new BadRequestException("duplicateToTaskId is required when marking duplicate");
    }

    const [updated] = await this.db
      .update(intakeItems)
      .set({
        status: decision,
        snoozedTill: opts.snoozedTill ? new Date(opts.snoozedTill) : null,
        duplicateToTaskId: opts.duplicateToTaskId ?? null,
        triagedById: userId,
        triagedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(intakeItems.id, itemId))
      .returning();

    if (decision === "accepted") {
      const status = opts.statusId
        ? await this.db.query.statuses.findFirst({
            where: and(eq(statuses.id, opts.statusId), eq(statuses.organizationId, orgId)),
          })
        : null;

      await this.db
        .update(tasks)
        .set({
          archivedAt: null,
          statusId: status?.id ?? undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, item.taskId), eq(tasks.organizationId, orgId)));
    }

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "intake_item",
      entityId: itemId,
      action: decision,
      changes: [{ field: "status", from: item.status, to: decision }],
    });

    return updated!;
  }
}
