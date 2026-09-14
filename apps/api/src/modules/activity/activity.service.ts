import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { activityLog, documents, milestones, projectStages, projects, statuses, tasks, users } from "../../db/schema.js";

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
    | "stage"
    | "milestone"
    | "intake_item"
    | "company"
    | "contact"
    | "deal"
    | "estimate"
    | "meeting"
    | "document"
    | "project";
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

  /**
   * Row 102: everything that happened on one project - its tasks and comments,
   * stages, milestones, docs filed under it, and team/detail changes - with the
   * entity each row is about resolved to a label so the feed reads as prose.
   */
  async listForProject(orgId: string, projectId: string, limit = 150) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true, spaceId: true },
    });
    if (!project) return { entries: [], statuses: {}, users: {} };
    const conds = [
      and(inArray(activityLog.entityType, ["list", "project"]), eq(activityLog.entityId, projectId)),
      and(eq(activityLog.entityType, "stage"), sql`${activityLog.entityId} in (select id from project_stages where project_id = ${projectId})`),
      and(eq(activityLog.entityType, "milestone"), sql`${activityLog.entityId} in (select id from milestones where project_id = ${projectId})`),
      and(eq(activityLog.entityType, "document"), sql`${activityLog.entityId} in (select id from documents where project_id = ${projectId})`),
    ];
    if (project.spaceId) {
      conds.push(
        and(
          eq(activityLog.entityType, "task"),
          sql`${activityLog.entityId} in (select t.id from tasks t join lists l on l.id = t.list_id where l.space_id = ${project.spaceId})`,
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.organizationId, orgId), or(...conds)))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
    const base = await this.withActors(rows);

    // Labels for the things the rows are about.
    const idsOf = (type: string) => [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))];
    const [taskRows, stageRows, msRows, docRows] = await Promise.all([
      idsOf("task").length ? this.db.select({ id: tasks.id, reference: tasks.reference, title: tasks.title }).from(tasks).where(inArray(tasks.id, idsOf("task"))) : [],
      idsOf("stage").length ? this.db.select({ id: projectStages.id, name: projectStages.name }).from(projectStages).where(inArray(projectStages.id, idsOf("stage"))) : [],
      idsOf("milestone").length ? this.db.select({ id: milestones.id, name: milestones.name }).from(milestones).where(inArray(milestones.id, idsOf("milestone"))) : [],
      idsOf("document").length ? this.db.select({ id: documents.id, title: documents.title }).from(documents).where(inArray(documents.id, idsOf("document"))) : [],
    ]);
    const labels = new Map<string, string>();
    for (const t of taskRows) labels.set(t.id, t.reference ? `${t.reference} ${t.title}` : t.title);
    for (const st of stageRows) labels.set(st.id, st.name);
    for (const m of msRows) labels.set(m.id, m.name);
    for (const d of docRows) labels.set(d.id, d.title || "Untitled");

    // Names for ids that show up inside field diffs (status moves, assignees, members).
    const statusIds = new Set<string>();
    const userIds = new Set<string>();
    for (const e of base) {
      for (const c of e.changes) {
        if (c.field === "statusId") for (const v of [c.from, c.to]) if (typeof v === "string") statusIds.add(v);
        if (["member", "memberRole", "leadId", "assigneeId"].includes(c.field) || e.action === "assigned" || e.action === "unassigned") {
          for (const v of [c.from, c.to]) if (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)) userIds.add(v);
        }
      }
    }
    const [statusRows, userRows] = await Promise.all([
      statusIds.size ? this.db.select({ id: statuses.id, name: statuses.name }).from(statuses).where(inArray(statuses.id, [...statusIds])) : [],
      userIds.size ? this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...userIds])) : [],
    ]);

    return {
      entries: base.map((e) => ({ ...e, entity: { type: e.entityType, id: e.entityId, label: labels.get(e.entityId) ?? null } })),
      statuses: Object.fromEntries(statusRows.map((s) => [s.id, s.name])),
      users: Object.fromEntries(userRows.map((u) => [u.id, u.name])),
    };
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
