import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { activityLog, users } from "../../db/schema.js";

/** One field-level change. Stored as an array in `activity_log.changes`. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface RecordActivity {
  orgId: string;
  actorId: string | null;
  entityType:
    | "task"
    | "comment"
    | "list"
    | "cycle"
    | "intake_item"
    | "company"
    | "contact"
    | "deal"
    | "estimate"
    | "meeting";
  entityId: string;
  action: string;
  changes?: FieldChange[];
}

/**
 * The audit trail. Every mutation that a human would care about writes exactly
 * one row here, and notifications are derived from those rows rather than
 * emitted separately at each call site — so "what happened" and "who was told"
 * can't drift apart.
 *
 * Changes are stored as field-level diffs ({field, from, to}) rather than prose,
 * which is what lets the UI render "moved from To Do to In Progress" without the
 * writer having to compose a sentence.
 */
@Injectable()
export class ActivityService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async record(input: RecordActivity) {
    const [row] = await this.db
      .insert(activityLog)
      .values({
        organizationId: input.orgId,
        actorId: input.actorId,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        changes: input.changes?.length ? { fields: input.changes } : null,
      })
      .returning();
    return row!;
  }

  /**
   * Compares two snapshots and returns only what actually moved. Undefined
   * values in `after` mean "not submitted", not "cleared", so they're skipped —
   * otherwise a PATCH of one field would log every other field as nulled.
   */
  diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    fields: string[],
  ): FieldChange[] {
    const changes: FieldChange[] = [];
    for (const field of fields) {
      if (after[field] === undefined) continue;
      const from = normalise(before[field]);
      const to = normalise(after[field]);
      if (from !== to) changes.push({ field, from: before[field] ?? null, to: after[field] ?? null });
    }
    return changes;
  }

  /** Newest-first history for one entity, with the actor resolved. */
  async listFor(orgId: string, entityType: string, entityId: string, limit = 100) {
    const rows = await this.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.organizationId, orgId),
          eq(activityLog.entityType, entityType),
          eq(activityLog.entityId, entityId),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    return this.withActors(rows);
  }

  /** Org-wide feed — powers a "recent activity" panel. */
  async listForOrg(orgId: string, limit = 50) {
    const rows = await this.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.organizationId, orgId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    return this.withActors(rows);
  }

  /** One extra query for all actors rather than a join per row. */
  private async withActors(rows: (typeof activityLog.$inferSelect)[]) {
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await this.db.select().from(users).where(inArray(users.id, actorIds))
      : [];
    const byId = new Map(actors.map((a) => [a.id, a]));

    return rows.map((r) => {
      const actor = r.actorId ? byId.get(r.actorId) : undefined;
      return {
        id: r.id,
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
        changes: (r.changes as { fields?: FieldChange[] } | null)?.fields ?? [],
        createdAt: r.createdAt,
        actor: actor
          ? { id: actor.id, name: actor.name, avatarUrl: actor.avatarUrl }
          : null,
      };
    });
  }
}

/** Dates and ids compare badly by reference; flatten to a primitive first. */
function normalise(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
