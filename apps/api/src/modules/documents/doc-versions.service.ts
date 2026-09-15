import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { documentVersions, documents } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

const AUTO_GAP_MS = 10 * 60 * 1000;

/** Row 21: snapshots of a doc, and going back to one. */
@Injectable()
export class DocVersionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  private shape(v: typeof documentVersions.$inferSelect & { createdBy?: { id: string; name: string } | null }, withContent = false) {
    return {
      id: v.id,
      documentId: v.documentId,
      title: v.title,
      reason: v.reason as "auto" | "manual" | "restore",
      label: v.label,
      createdBy: v.createdBy ?? null,
      createdAt: v.createdAt.toISOString(),
      words: v.body ? v.body.trim().split(/\s+/).filter(Boolean).length : 0,
      ...(withContent ? { content: v.content, body: v.body } : {}),
    };
  }

  /**
   * Called before an edit is written. Snapshots the state that is about to be
   * replaced, unless this same person already snapshotted within 10 minutes
   * (typing shouldn't produce a version per keystroke).
   */
  async autoSnapshot(orgId: string, docId: string, userId: string, prev: { title: string; content: Record<string, unknown> | null; body: string }) {
    const last = await this.db.query.documentVersions.findFirst({ where: eq(documentVersions.documentId, docId), orderBy: [desc(documentVersions.createdAt)] });
    if (last && last.createdById === userId && last.reason === "auto" && Date.now() - last.createdAt.getTime() < AUTO_GAP_MS) return null;
    if (last && last.title === prev.title && JSON.stringify(last.content) === JSON.stringify(prev.content) && last.body === prev.body) return null;
    const [row] = await this.db.insert(documentVersions).values({ organizationId: orgId, documentId: docId, title: prev.title, content: prev.content, body: prev.body, reason: "auto", createdById: userId }).returning();
    return row!;
  }

  async list(orgId: string, docId: string) {
    const rows = await this.db.query.documentVersions.findMany({
      where: and(eq(documentVersions.organizationId, orgId), eq(documentVersions.documentId, docId)),
      with: { createdBy: { columns: { id: true, name: true } } },
      orderBy: [desc(documentVersions.createdAt)],
      limit: 200,
    });
    return rows.map((v) => this.shape(v));
  }

  async get(orgId: string, docId: string, id: string) {
    const v = await this.db.query.documentVersions.findFirst({ where: and(eq(documentVersions.id, id), eq(documentVersions.documentId, docId), eq(documentVersions.organizationId, orgId)), with: { createdBy: { columns: { id: true, name: true } } } });
    if (!v) throw new NotFoundException("Version not found");
    return this.shape(v, true);
  }

  /** "Save version": a named snapshot of the current state. */
  async save(orgId: string, docId: string, userId: string, label?: string | null) {
    const doc = await this.db.query.documents.findFirst({ where: and(eq(documents.id, docId), eq(documents.organizationId, orgId)), columns: { title: true, content: true, body: true } });
    if (!doc) throw new NotFoundException("Document not found");
    const [row] = await this.db.insert(documentVersions).values({ organizationId: orgId, documentId: docId, title: doc.title, content: doc.content, body: doc.body, reason: "manual", label: label?.trim() || null, createdById: userId }).returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "document", entityId: docId, action: "version_saved", changes: label ? [{ field: "label", from: null, to: label }] : undefined });
    return this.shape(row!);
  }

  /** Put a version back. The state being replaced is snapshotted first, so a restore can itself be undone. */
  async restore(orgId: string, docId: string, userId: string, id: string) {
    const v = await this.db.query.documentVersions.findFirst({ where: and(eq(documentVersions.id, id), eq(documentVersions.documentId, docId), eq(documentVersions.organizationId, orgId)) });
    if (!v) throw new NotFoundException("Version not found");
    const doc = await this.db.query.documents.findFirst({ where: and(eq(documents.id, docId), eq(documents.organizationId, orgId)), columns: { title: true, content: true, body: true } });
    if (!doc) throw new NotFoundException("Document not found");
    await this.db.insert(documentVersions).values({ organizationId: orgId, documentId: docId, title: doc.title, content: doc.content, body: doc.body, reason: "restore", label: "Before restore", createdById: userId });
    await this.db.update(documents).set({ title: v.title, content: v.content, body: v.body, updatedById: userId, updatedAt: new Date() }).where(eq(documents.id, docId));
    await this.activity.record({ orgId, actorId: userId, entityType: "document", entityId: docId, action: "version_restored", changes: [{ field: "version", from: null, to: `${v.label ?? v.reason} · ${v.createdAt.toISOString()}` }] });
    return { restored: id };
  }
}
