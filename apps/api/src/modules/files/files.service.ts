import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { attachments, channelMembers, tasks } from "../../db/schema.js";
import { StorageService } from "./storage.service.js";

export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

type Row = typeof attachments.$inferSelect & { uploader?: { id: string; name: string } | null };

/** Files shared in chat (row 43) and attached to tasks — one table, one store. */
@Injectable()
export class FilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly storage: StorageService,
  ) {}

  async upload(orgId: string, userId: string, file: UploadedFileLike, target: { channelId?: string; taskId?: string }) {
    if (!target.channelId && !target.taskId) throw new BadRequestException("channelId or taskId is required");
    if (target.channelId) {
      const m = await this.db.query.channelMembers.findFirst({
        where: and(eq(channelMembers.channelId, target.channelId), eq(channelMembers.userId, userId), eq(channelMembers.organizationId, orgId)),
      });
      if (!m) throw new ForbiddenException("Not a member of this channel");
    }
    if (target.taskId) {
      const t = await this.db.query.tasks.findFirst({ where: and(eq(tasks.id, target.taskId), eq(tasks.organizationId, orgId)), columns: { id: true } });
      if (!t) throw new NotFoundException("Task not found");
    }
    const id = randomUUID();
    const filename = file.originalname.replace(/[^\w.\-() ]+/g, "_").slice(0, 200) || "file";
    const mimeType = file.mimetype || "application/octet-stream";
    const key = `${orgId}/${target.channelId ? `chat/${target.channelId}` : `tasks/${target.taskId}`}/${id}-${filename}`;
    await this.storage.put(key, file.buffer, mimeType);
    const [row] = await this.db
      .insert(attachments)
      .values({
        id,
        organizationId: orgId,
        taskId: target.taskId ?? null,
        channelId: target.channelId ?? null,
        uploadedById: userId,
        filename,
        mimeType,
        sizeBytes: file.size,
        storageKey: key,
      })
      .returning();
    return this.shape(row!);
  }

  /** Everything shared in a channel — the Files tab. Newest first, with who posted it. */
  async listForChannel(orgId: string, channelId: string, userId: string) {
    const m = await this.db.query.channelMembers.findFirst({
      where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
    });
    if (!m) throw new ForbiddenException("Not a member of this channel");
    const rows = await this.db.query.attachments.findMany({
      where: and(eq(attachments.organizationId, orgId), eq(attachments.channelId, channelId), isNull(attachments.archivedAt)),
      with: { uploader: { columns: { id: true, name: true } } },
      orderBy: [desc(attachments.createdAt)],
      limit: 500,
    });
    // Files uploaded but never sent (composer abandoned) stay out of the tab.
    return Promise.all(rows.filter((r) => r.messageId).map((r) => this.shape(r)));
  }

  /** Attachments for a set of messages, grouped by message id. */
  async forMessages(messageIds: string[]) {
    const out = new Map<string, Awaited<ReturnType<FilesService["shape"]>>[]>();
    if (!messageIds.length) return out;
    const rows = await this.db.query.attachments.findMany({
      where: and(inArray(attachments.messageId, messageIds), isNull(attachments.archivedAt)),
      orderBy: [attachments.createdAt],
    });
    for (const r of rows) {
      const list = out.get(r.messageId!) ?? [];
      list.push(await this.shape(r));
      out.set(r.messageId!, list);
    }
    return out;
  }

  /** Bind freshly uploaded (still unsent) files to the message they went out with. */
  async attachToMessage(orgId: string, channelId: string, messageId: string, attachmentIds: string[]) {
    if (!attachmentIds.length) return;
    await this.db
      .update(attachments)
      .set({ messageId, updatedAt: new Date() })
      .where(and(inArray(attachments.id, attachmentIds), eq(attachments.organizationId, orgId), eq(attachments.channelId, channelId), isNull(attachments.messageId)));
  }

  /** Local-storage bytes for /files/:id/raw. */
  async raw(id: string) {
    const row = await this.db.query.attachments.findFirst({ where: eq(attachments.id, id) });
    if (!row || row.archivedAt) throw new NotFoundException("File not found");
    return { row, stream: this.storage.localStream(row.storageKey) };
  }

  async remove(orgId: string, userId: string, role: string, id: string) {
    const row = await this.db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.organizationId, orgId)) });
    if (!row) throw new NotFoundException("File not found");
    if (row.uploadedById !== userId && role !== "owner" && role !== "admin") throw new ForbiddenException("Only the uploader or an admin can delete this file");
    await this.storage.remove(row.storageKey);
    await this.db.delete(attachments).where(eq(attachments.id, id));
    return { id, deleted: true };
  }

  private async shape(r: Row) {
    return {
      id: r.id,
      filename: r.filename,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      taskId: r.taskId,
      channelId: r.channelId,
      messageId: r.messageId,
      createdAt: r.createdAt,
      uploadedBy: r.uploader ? { id: r.uploader.id, name: r.uploader.name } : null,
      url: await this.storage.url(r.storageKey, r.id, r.filename),
    };
  }
}
