import { Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { activityLog, documents, lists, projects, tasks, users } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { backgroundJobsEnabled, registerJob } from "../../common/jobs.js";

export type TrashType = "task" | "document" | "project";
const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Row 125: deleting a task, doc or project only stamps `archivedAt`. Anything
 * stamped in the last 30 days sits in the Trash and can be restored; a daily
 * sweep removes what is older for good.
 */
@Injectable()
export class TrashService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrashService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  onModuleInit() {
    registerJob("trash.purge", () => this.purge());
    if (!backgroundJobsEnabled()) return; // serverless: an external scheduler calls the job instead
    this.timer = setInterval(() => void this.purge(), 6 * 60 * 60 * 1000);
    setTimeout(() => void this.purge(), 30_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async list(orgId: string) {
    const since = new Date(Date.now() - RETENTION_DAYS * DAY_MS);
    const [taskRows, docRows, projectRows] = await Promise.all([
      this.db
        .select({ id: tasks.id, title: tasks.title, reference: tasks.reference, deletedAt: tasks.archivedAt, context: lists.name })
        .from(tasks)
        .leftJoin(lists, eq(lists.id, tasks.listId))
        .where(and(eq(tasks.organizationId, orgId), isNotNull(tasks.archivedAt), gt(tasks.archivedAt, since)))
        .orderBy(desc(tasks.archivedAt)),
      this.db
        .select({ id: documents.id, title: documents.title, deletedAt: documents.archivedAt, context: projects.name })
        .from(documents)
        .leftJoin(projects, eq(projects.id, documents.projectId))
        .where(and(eq(documents.organizationId, orgId), isNotNull(documents.archivedAt), gt(documents.archivedAt, since)))
        .orderBy(desc(documents.archivedAt)),
      this.db
        .select({ id: projects.id, title: projects.name, deletedAt: projects.archivedAt, context: projects.clientName })
        .from(projects)
        .where(and(eq(projects.organizationId, orgId), isNotNull(projects.archivedAt), gt(projects.archivedAt, since)))
        .orderBy(desc(projects.archivedAt)),
    ]);
    const items = [
      ...taskRows.map((t) => ({ type: "task" as TrashType, id: t.id, title: t.reference ? `${t.reference} ${t.title}` : t.title, context: t.context, deletedAt: t.deletedAt! })),
      ...docRows.map((d) => ({ type: "document" as TrashType, id: d.id, title: d.title || "Untitled", context: d.context, deletedAt: d.deletedAt! })),
      ...projectRows.map((p) => ({ type: "project" as TrashType, id: p.id, title: p.title, context: p.context, deletedAt: p.deletedAt! })),
    ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
    // Who deleted it: the latest archive/delete row in the audit trail.
    const ids = items.map((i) => i.id);
    const actors = ids.length
      ? await this.db
          .select({ entityId: activityLog.entityId, entityType: activityLog.entityType, actorId: activityLog.actorId, name: users.name, createdAt: activityLog.createdAt })
          .from(activityLog)
          .leftJoin(users, eq(users.id, activityLog.actorId))
          .where(and(eq(activityLog.organizationId, orgId), inArray(activityLog.entityId, ids), inArray(activityLog.action, ["archived", "deleted", "trashed"])))
          .orderBy(desc(activityLog.createdAt))
      : [];
    const by = new Map<string, string>();
    for (const a of actors) if (!by.has(a.entityId) && a.name) by.set(a.entityId, a.name);
    return items.map((i) => ({
      ...i,
      deletedAt: i.deletedAt.toISOString(),
      deletedBy: by.get(i.id) ?? null,
      expiresAt: new Date(i.deletedAt.getTime() + RETENTION_DAYS * DAY_MS).toISOString(),
      daysLeft: Math.max(0, Math.ceil((i.deletedAt.getTime() + RETENTION_DAYS * DAY_MS - Date.now()) / DAY_MS)),
    }));
  }

  async restore(orgId: string, userId: string, type: TrashType, id: string) {
    const table = type === "task" ? tasks : type === "document" ? documents : projects;
    const rows = await this.db.update(table).set({ archivedAt: null, updatedAt: new Date() }).where(and(eq(table.id, id), eq(table.organizationId, orgId), isNotNull(table.archivedAt))).returning({ id: table.id });
    if (!rows.length) throw new NotFoundException("Nothing to restore");
    if (type === "document") {
      // A restored doc comes back as a draft at its old place in the tree; nothing else changes.
    }
    await this.activity.record({ orgId, actorId: userId, entityType: type, entityId: id, action: "restored" });
    return { type, id, restored: true };
  }

  async destroy(orgId: string, userId: string, type: TrashType, id: string) {
    const table = type === "task" ? tasks : type === "document" ? documents : projects;
    const rows = await this.db.delete(table).where(and(eq(table.id, id), eq(table.organizationId, orgId), isNotNull(table.archivedAt))).returning({ id: table.id });
    if (!rows.length) throw new NotFoundException("Only trashed items can be deleted for good");
    await this.activity.record({ orgId, actorId: userId, entityType: type, entityId: id, action: "purged" });
    return { type, id, purged: true };
  }

  /** Permanently delete anything trashed more than 30 days ago. */
  async purge() {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS);
    try {
      const [t, d, p] = await Promise.all([
        this.db.delete(tasks).where(and(isNotNull(tasks.archivedAt), lt(tasks.archivedAt, cutoff))).returning({ id: tasks.id }),
        this.db.delete(documents).where(and(isNotNull(documents.archivedAt), lt(documents.archivedAt, cutoff))).returning({ id: documents.id }),
        this.db.delete(projects).where(and(isNotNull(projects.archivedAt), lt(projects.archivedAt, cutoff), sql`${projects.kind} <> 'internal'`)).returning({ id: projects.id }),
      ]);
      const n = t.length + d.length + p.length;
      if (n) this.logger.log(`purged ${n} item(s) older than ${RETENTION_DAYS} days from the trash`);
      return { tasks: t.length, documents: d.length, projects: p.length };
    } catch (err) {
      this.logger.warn(`trash purge failed: ${(err as Error).message}`);
      return { tasks: 0, documents: 0, projects: 0 };
    }
  }
}
