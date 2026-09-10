import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { reactions, users } from "../../db/schema.js";

export type ReactionEntity = "task" | "comment" | "message";

/** A grouped reaction as the UI wants it: one entry per emoji. */
export interface ReactionGroup {
  emoji: string;
  count: number;
  reacted: boolean;
  users: { id: string; name: string }[];
}

@Injectable()
export class ReactionsService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /**
   * Clicking an emoji you've already used removes it — that toggle is why this
   * is one endpoint rather than an add/remove pair, and why the unique index on
   * (user, entity, emoji) is the thing keeping it honest under double-clicks.
   */
  async toggle(
    orgId: string,
    userId: string,
    entityType: ReactionEntity,
    entityId: string,
    emoji: string,
  ) {
    const existing = await this.db.query.reactions.findFirst({
      where: and(
        eq(reactions.userId, userId),
        eq(reactions.entityType, entityType),
        eq(reactions.entityId, entityId),
        eq(reactions.emoji, emoji),
      ),
    });

    if (existing) {
      await this.db.delete(reactions).where(eq(reactions.id, existing.id));
    } else {
      await this.db
        .insert(reactions)
        .values({ organizationId: orgId, userId, entityType, entityId, emoji })
        .onConflictDoNothing();
    }

    return this.forEntity(orgId, userId, entityType, entityId);
  }

  async forEntity(
    orgId: string,
    userId: string,
    entityType: ReactionEntity,
    entityId: string,
  ): Promise<ReactionGroup[]> {
    const grouped = await this.forEntities(orgId, userId, entityType, [entityId]);
    return grouped[entityId] ?? [];
  }

  /**
   * Batch variant — a chat pane or comment list needs reactions for many rows at
   * once, and doing it per row is how you end up with 50 queries per render.
   */
  async forEntities(
    orgId: string,
    userId: string,
    entityType: ReactionEntity,
    entityIds: string[],
  ): Promise<Record<string, ReactionGroup[]>> {
    if (!entityIds.length) return {};

    const rows = await this.db
      .select()
      .from(reactions)
      .where(
        and(
          eq(reactions.organizationId, orgId),
          eq(reactions.entityType, entityType),
          inArray(reactions.entityId, entityIds),
        ),
      );
    if (!rows.length) return {};

    const people = await this.db
      .select()
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((r) => r.userId))]));
    const nameById = new Map(people.map((p) => [p.id, p.name]));

    const out: Record<string, ReactionGroup[]> = {};
    for (const row of rows) {
      const groups = (out[row.entityId] ??= []);
      let group = groups.find((g) => g.emoji === row.emoji);
      if (!group) {
        group = { emoji: row.emoji, count: 0, reacted: false, users: [] };
        groups.push(group);
      }
      group.count += 1;
      if (row.userId === userId) group.reacted = true;
      group.users.push({ id: row.userId, name: nameById.get(row.userId) ?? "Someone" });
    }
    return out;
  }
}
