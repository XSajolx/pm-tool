import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { crmNotes } from "../../db/schema.js";
import type { Role } from "../auth/auth.types.js";

export type NoteEntity = "company" | "contact" | "deal";

@Injectable()
export class NotesService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /** Pinned first, then newest. */
  async list(orgId: string, entityType: NoteEntity, entityId: string) {
    const rows = await this.db.query.crmNotes.findMany({
      where: and(
        eq(crmNotes.organizationId, orgId),
        eq(crmNotes.entityType, entityType),
        eq(crmNotes.entityId, entityId),
      ),
      with: { author: true },
      orderBy: [desc(crmNotes.pinned), desc(crmNotes.createdAt)],
    });
    return rows.map(shape);
  }

  async create(orgId: string, userId: string, entityType: NoteEntity, entityId: string, body: string) {
    const [row] = await this.db
      .insert(crmNotes)
      .values({ organizationId: orgId, entityType, entityId, body, authorId: userId })
      .returning();
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, actor: { userId: string; role: Role }, id: string, body: string) {
    await this.owned(orgId, actor, id);
    await this.db.update(crmNotes).set({ body, updatedAt: new Date() }).where(eq(crmNotes.id, id));
    return this.get(orgId, id);
  }

  async togglePin(orgId: string, id: string) {
    const note = await this.get(orgId, id);
    await this.db.update(crmNotes).set({ pinned: !note.pinned, updatedAt: new Date() }).where(eq(crmNotes.id, id));
    return this.get(orgId, id);
  }

  async remove(orgId: string, actor: { userId: string; role: Role }, id: string) {
    await this.owned(orgId, actor, id);
    await this.db.delete(crmNotes).where(eq(crmNotes.id, id));
    return { id, deleted: true };
  }

  private async get(orgId: string, id: string) {
    const row = await this.db.query.crmNotes.findFirst({
      where: and(eq(crmNotes.id, id), eq(crmNotes.organizationId, orgId)),
      with: { author: true },
    });
    if (!row) throw new NotFoundException("Note not found");
    return shape(row);
  }

  /** Authors edit their own notes; admins can edit anyone's. */
  private async owned(orgId: string, actor: { userId: string; role: Role }, id: string) {
    const note = await this.get(orgId, id);
    const isAdmin = actor.role === "owner" || actor.role === "admin";
    if (note.author.id !== actor.userId && !isAdmin) {
      throw new ForbiddenException("Only the author can change this note");
    }
    return note;
  }
}

function shape(r: typeof crmNotes.$inferSelect & { author: { id: string; name: string; avatarUrl: string | null } }) {
  return {
    id: r.id,
    entityType: r.entityType,
    entityId: r.entityId,
    body: r.body,
    pinned: r.pinned,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    author: { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl },
  };
}
