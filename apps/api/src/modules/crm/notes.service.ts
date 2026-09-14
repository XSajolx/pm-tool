import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { contacts, crmNotes, deals } from "../../db/schema.js";
import type { Role } from "../auth/auth.types.js";

export type NoteEntity = "company" | "contact" | "deal";
export type NoteKind = "note" | "call" | "meeting" | "email";

export interface NoteWrite {
  body: string;
  kind?: NoteKind;
  occurredAt?: string | null;
}

@Injectable()
export class NotesService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /**
   * The interaction log (row 54). Pinned first, then by when it happened.
   * A company's log also folds in everything logged against its contacts
   * and deals, so whoever picks up the account sees the whole history.
   */
  async list(orgId: string, entityType: NoteEntity, entityId: string) {
    const own = and(eq(crmNotes.entityType, entityType), eq(crmNotes.entityId, entityId));
    let where = own;
    const about = new Map<string, { type: NoteEntity; id: string; name: string }>();
    if (entityType === "company") {
      const [cs, ds] = await Promise.all([
        this.db.query.contacts.findMany({ where: and(eq(contacts.companyId, entityId), isNull(contacts.archivedAt)), columns: { id: true, firstName: true, lastName: true } }),
        this.db.query.deals.findMany({ where: and(eq(deals.companyId, entityId), isNull(deals.archivedAt)), columns: { id: true, title: true } }),
      ]);
      for (const c of cs) about.set(c.id, { type: "contact", id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") });
      for (const d of ds) about.set(d.id, { type: "deal", id: d.id, name: d.title });
      const parts = [own];
      if (cs.length) parts.push(and(eq(crmNotes.entityType, "contact"), inArray(crmNotes.entityId, cs.map((c) => c.id))));
      if (ds.length) parts.push(and(eq(crmNotes.entityType, "deal"), inArray(crmNotes.entityId, ds.map((d) => d.id))));
      where = parts.length > 1 ? or(...parts) : own;
    }
    const rows = await this.db.query.crmNotes.findMany({
      where: and(eq(crmNotes.organizationId, orgId), where),
      with: { author: true },
      orderBy: [desc(crmNotes.pinned), desc(crmNotes.occurredAt), desc(crmNotes.createdAt)],
    });
    return rows.map((r) => ({ ...shape(r), about: r.entityId !== entityId ? (about.get(r.entityId) ?? null) : null }));
  }

  async create(orgId: string, userId: string, entityType: NoteEntity, entityId: string, dto: NoteWrite) {
    const [row] = await this.db
      .insert(crmNotes)
      .values({
        organizationId: orgId,
        entityType,
        entityId,
        body: dto.body,
        kind: dto.kind ?? "note",
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
        authorId: userId,
      })
      .returning();
    // Row 55: a logged call/meeting/note counts as activity on the deal.
    if (entityType === "deal") await this.db.update(deals).set({ lastActivityAt: new Date() }).where(and(eq(deals.id, entityId), eq(deals.organizationId, orgId)));
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, actor: { userId: string; role: Role }, id: string, dto: Partial<NoteWrite>) {
    await this.owned(orgId, actor, id);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.body !== undefined) patch.body = dto.body;
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.occurredAt) patch.occurredAt = new Date(dto.occurredAt);
    await this.db.update(crmNotes).set(patch).where(eq(crmNotes.id, id));
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
    kind: r.kind,
    occurredAt: r.occurredAt,
    pinned: r.pinned,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    author: { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl },
  };
}
