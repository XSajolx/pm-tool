import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { snippets } from "../../db/schema.js";
import { textOf, type PmNode } from "./doc-content.js";

export interface SnippetWrite {
  name?: string;
  content?: Record<string, unknown> | null;
  body?: string;
}

/** Row 66: reusable blocks referenced by id from docs. */
@Injectable()
export class SnippetsService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async list(orgId: string) {
    const rows = await this.db.query.snippets.findMany({
      where: and(eq(snippets.organizationId, orgId), isNull(snippets.archivedAt)),
      orderBy: [asc(snippets.name)],
    });
    return rows.map((s) => ({ id: s.id, name: s.name, content: s.content, body: s.body, updatedAt: s.updatedAt }));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.snippets.findFirst({ where: and(eq(snippets.id, id), eq(snippets.organizationId, orgId), isNull(snippets.archivedAt)) });
    if (!row) throw new NotFoundException("Snippet not found");
    return { id: row.id, name: row.name, content: row.content, body: row.body, updatedAt: row.updatedAt };
  }

  async create(orgId: string, userId: string, dto: SnippetWrite & { name: string }) {
    const [row] = await this.db
      .insert(snippets)
      .values({ organizationId: orgId, name: dto.name.trim(), content: dto.content ?? null, body: dto.body ?? (dto.content ? textOf(dto.content as PmNode) : ""), createdById: userId, updatedById: userId })
      .returning();
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: SnippetWrite) {
    await this.get(orgId, id);
    const patch: Record<string, unknown> = { updatedById: userId, updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.content !== undefined) {
      patch.content = dto.content;
      patch.body = dto.body ?? (dto.content ? textOf(dto.content as PmNode) : "");
    } else if (dto.body !== undefined) patch.body = dto.body;
    await this.db.update(snippets).set(patch).where(eq(snippets.id, id));
    return this.get(orgId, id);
  }

  async remove(orgId: string, id: string) {
    await this.db.update(snippets).set({ archivedAt: new Date() }).where(and(eq(snippets.id, id), eq(snippets.organizationId, orgId)));
    return { id, removed: true };
  }

  /** Content for a set of snippet ids (used when a doc leaves the app: share link, PDF). */
  async contentsFor(orgId: string, ids: string[]) {
    const out = new Map<string, PmNode | null>();
    if (!ids.length) return out;
    const rows = await this.db.query.snippets.findMany({ where: and(eq(snippets.organizationId, orgId), inArray(snippets.id, ids)) });
    for (const r of rows) out.set(r.id, (r.content as PmNode | null) ?? null);
    return out;
  }
}
