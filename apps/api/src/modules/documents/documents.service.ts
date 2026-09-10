import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { documents } from "../../db/schema.js";
import type { Role } from "../auth/auth.types.js";

@Injectable()
export class DocumentsService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async list(orgId: string, projectId?: string) {
    const rows = await this.db.query.documents.findMany({
      where: and(
        eq(documents.organizationId, orgId),
        isNull(documents.archivedAt),
        ...(projectId ? [eq(documents.projectId, projectId)] : []),
      ),
      with: { project: true, updatedBy: true },
      orderBy: desc(documents.updatedAt),
    });
    return rows.map((d) => ({
      id: d.id,
      title: d.title,
      excerpt: d.body.slice(0, 160),
      project: d.project ? { id: d.project.id, name: d.project.name } : null,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy ? { id: d.updatedBy.id, name: d.updatedBy.name } : null,
    }));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.documents.findFirst({
      where: and(eq(documents.id, id), eq(documents.organizationId, orgId)),
      with: { project: true, createdBy: true, updatedBy: true },
    });
    if (!row) throw new NotFoundException("Document not found");
    return {
      ...row,
      project: row.project ? { id: row.project.id, name: row.project.name } : null,
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
      updatedBy: row.updatedBy ? { id: row.updatedBy.id, name: row.updatedBy.name } : null,
    };
  }

  async create(orgId: string, userId: string, dto: { title: string; body?: string; projectId?: string | null }) {
    const [row] = await this.db
      .insert(documents)
      .values({
        organizationId: orgId,
        title: dto.title,
        body: dto.body ?? "",
        projectId: dto.projectId ?? null,
        createdById: userId,
        updatedById: userId,
      })
      .returning();
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: { title?: string; body?: string; projectId?: string | null }) {
    await this.get(orgId, id);
    await this.db
      .update(documents)
      .set({ ...dto, updatedById: userId, updatedAt: new Date() })
      .where(eq(documents.id, id));
    return this.get(orgId, id);
  }

  /** Creator or admin can archive. */
  async archive(orgId: string, actor: { userId: string; role: Role }, id: string) {
    const doc = await this.get(orgId, id);
    const isAdmin = actor.role === "owner" || actor.role === "admin";
    if (doc.createdBy?.id !== actor.userId && !isAdmin) {
      throw new ForbiddenException("Only the author or an admin can delete this document");
    }
    await this.db.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, id));
    return { id, archived: true };
  }
}
