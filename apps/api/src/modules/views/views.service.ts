import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { views } from "../../db/schema.js";

export interface SaveViewDto {
  name: string;
  listId?: string;
  spaceId?: string;
  layout?: string;
  filters: Record<string, unknown>;
  isShared?: boolean;
}

@Injectable()
export class ViewsService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /**
   * Views the caller can see for a list: their own, plus anything a colleague
   * marked shared. Private views of other people are invisible, which is what
   * makes "private" mean something.
   */
  async listFor(orgId: string, userId: string, listId?: string) {
    const scope = listId ? eq(views.listId, listId) : undefined;
    return this.db
      .select()
      .from(views)
      .where(
        and(
          eq(views.organizationId, orgId),
          or(eq(views.createdById, userId), eq(views.isShared, true)),
          ...(scope ? [scope] : []),
        ),
      );
  }

  async create(orgId: string, userId: string, dto: SaveViewDto) {
    const [row] = await this.db
      .insert(views)
      .values({
        organizationId: orgId,
        listId: dto.listId ?? null,
        spaceId: dto.spaceId ?? null,
        name: dto.name,
        layout: dto.layout ?? "list",
        filters: dto.filters,
        isShared: dto.isShared ?? false,
        createdById: userId,
      })
      .returning();
    return row!;
  }

  /** Only the author can change or delete a view, shared or not. */
  async update(orgId: string, userId: string, id: string, patch: Partial<SaveViewDto>) {
    const existing = await this.owned(orgId, userId, id);
    const [row] = await this.db
      .update(views)
      .set({
        name: patch.name ?? existing.name,
        layout: patch.layout ?? existing.layout,
        filters: patch.filters ?? existing.filters,
        isShared: patch.isShared ?? existing.isShared,
        updatedAt: new Date(),
      })
      .where(eq(views.id, id))
      .returning();
    return row!;
  }

  async remove(orgId: string, userId: string, id: string) {
    await this.owned(orgId, userId, id);
    await this.db.delete(views).where(eq(views.id, id));
    return { id, deleted: true };
  }

  private async owned(orgId: string, userId: string, id: string) {
    const row = await this.db.query.views.findFirst({
      where: and(eq(views.id, id), eq(views.organizationId, orgId)),
    });
    if (!row) throw new NotFoundException("View not found");
    if (row.createdById !== userId) {
      throw new ForbiddenException("Only the author can modify this view");
    }
    return row;
  }
}
