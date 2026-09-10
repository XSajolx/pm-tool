import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  comments,
  notificationPreferences,
  notifications,
  taskAssignees,
  taskSubscribers,
  users,
} from "../../db/schema.js";
import { ChatGateway } from "../chat/chat.gateway.js";
import type { FieldChange } from "../activity/activity.service.js";

/** Which preference toggle gates a given verb. */
const PREFERENCE_FOR_VERB: Record<string, keyof PreferenceFlags> = {
  updated: "propertyChange",
  status_changed: "statusChange",
  commented: "comment",
  mentioned: "mention",
  comment_assigned: "mention",
  completed: "taskCompleted",
  assigned: "propertyChange",
};

/**
 * Verbs that are *addressed to you* rather than ambient. These land in the
 * Primary tab regardless of how the receiver relates to the task. A plain
 * comment is primary only for the task's assignees — for a mere follower it's
 * background noise, so it goes to Other.
 */
const ALWAYS_PRIMARY = new Set(["assigned", "mentioned", "comment_assigned"]);

export type InboxTab = "primary" | "other" | "replies" | "later" | "cleared";

interface PreferenceFlags {
  propertyChange: boolean;
  statusChange: boolean;
  comment: boolean;
  mention: boolean;
  taskCompleted: boolean;
}

const DEFAULT_PREFERENCES: PreferenceFlags = {
  propertyChange: true,
  statusChange: true,
  comment: true,
  mention: true,
  taskCompleted: true,
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly gateway: ChatGateway,
  ) {}

  /* ---------------------------------------------------------------- *
   * Fan-out
   * ---------------------------------------------------------------- */

  /**
   * Turns one task event into per-person notifications.
   *
   * Recipients are the task's subscribers, never the actor themselves — being
   * told about your own click is noise. Each recipient's preferences are checked
   * before the row is written, so an opt-out costs nothing at read time.
   *
   * Failures here are logged, not thrown: a notification that can't be delivered
   * must not roll back the task update that caused it.
   */
  async notifyTaskEvent(input: {
    orgId: string;
    taskId: string;
    actorId: string;
    verb: string;
    title: string;
    body?: string;
    changes?: FieldChange[];
    /** Receivers already notified directly (mentioned/assigned) — skip them here. */
    exclude?: string[];
  }) {
    try {
      const { recipients: all, assignees } = await this.subscribersOf(
        input.taskId,
        input.actorId,
      );
      const skip = new Set(input.exclude ?? []);
      const recipients = all.filter((id) => !skip.has(id));
      if (!recipients.length) return;

      const allowed = await this.filterByPreference(input.orgId, recipients, input.verb);
      if (!allowed.length) return;

      await this.insertAndPush(
        allowed.map((receiverId) => ({
          organizationId: input.orgId,
          receiverId,
          triggeredById: input.actorId,
          entityType: "task",
          entityId: input.taskId,
          verb: input.verb,
          category: this.categorise(input.verb, assignees.has(receiverId)),
          title: input.title,
          body: input.body ?? null,
          data: input.changes?.length ? { changes: input.changes } : null,
        })),
      );
    } catch (err) {
      this.logger.error(
        `notification fan-out failed for task ${input.taskId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Direct delivery to named people — @mentions and comment assignments. Always
   * Primary: someone chose these receivers deliberately, so no subscriber or
   * preference lookup applies beyond the mention toggle.
   */
  async notifyUsers(input: {
    orgId: string;
    receiverIds: string[];
    actorId: string;
    verb: "mentioned" | "comment_assigned";
    entityType: "task" | "comment" | "meeting";
    entityId: string;
    title: string;
    body?: string;
  }) {
    try {
      const receivers = [...new Set(input.receiverIds)].filter((id) => id !== input.actorId);
      if (!receivers.length) return;
      const allowed = await this.filterByPreference(input.orgId, receivers, input.verb);
      if (!allowed.length) return;

      await this.insertAndPush(
        allowed.map((receiverId) => ({
          organizationId: input.orgId,
          receiverId,
          triggeredById: input.actorId,
          entityType: input.entityType,
          entityId: input.entityId,
          verb: input.verb,
          category: "primary",
          title: input.title,
          body: input.body ?? null,
          data: null,
        })),
      );
    } catch (err) {
      this.logger.error(`direct notification failed: ${(err as Error).message}`);
    }
  }

  private async insertAndPush(values: (typeof notifications.$inferInsert)[]) {
    const rows = await this.db.insert(notifications).values(values).returning();
    // Push live to anyone with the app open.
    for (const row of rows) {
      this.gateway.emitToUser(row.receiverId, "notification:new", row);
    }
  }

  private categorise(verb: string, receiverIsAssignee: boolean): "primary" | "other" {
    if (ALWAYS_PRIMARY.has(verb)) return "primary";
    if (verb === "commented" && receiverIsAssignee) return "primary";
    return "other";
  }

  /** Assignees are auto-subscribed — that's how a task acquires followers. */
  async subscribe(orgId: string, taskId: string, userId: string) {
    await this.db
      .insert(taskSubscribers)
      .values({ taskId, userId, organizationId: orgId })
      .onConflictDoNothing();
  }

  async unsubscribe(taskId: string, userId: string) {
    await this.db
      .delete(taskSubscribers)
      .where(and(eq(taskSubscribers.taskId, taskId), eq(taskSubscribers.userId, userId)));
  }

  async isSubscribed(taskId: string, userId: string) {
    const row = await this.db.query.taskSubscribers.findFirst({
      where: and(eq(taskSubscribers.taskId, taskId), eq(taskSubscribers.userId, userId)),
    });
    return Boolean(row);
  }

  /**
   * Subscribers plus assignees (assignment implies interest even if the
   * subscriber row was never written), minus the person who caused the event.
   * The assignee set is returned too because it decides Primary vs Other.
   */
  private async subscribersOf(taskId: string, actorId: string) {
    const [subs, assigneeRows] = await Promise.all([
      this.db
        .select({ userId: taskSubscribers.userId })
        .from(taskSubscribers)
        .where(eq(taskSubscribers.taskId, taskId)),
      this.db
        .select({ userId: taskAssignees.userId })
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, taskId)),
    ]);

    const assignees = new Set(assigneeRows.map((r) => r.userId));
    const ids = new Set([...subs.map((r) => r.userId), ...assignees]);
    ids.delete(actorId);
    return { recipients: [...ids], assignees };
  }

  private async filterByPreference(orgId: string, userIds: string[], verb: string) {
    const key = PREFERENCE_FOR_VERB[verb];
    if (!key) return userIds; // Unknown verb: deliver rather than silently drop.

    const prefs = await this.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.organizationId, orgId),
          inArray(notificationPreferences.userId, userIds),
        ),
      );
    const byUser = new Map(prefs.map((p) => [p.userId, p]));

    // No row means the user has never touched their settings — everything on.
    return userIds.filter((id) => (byUser.get(id) ?? DEFAULT_PREFERENCES)[key]);
  }

  /* ---------------------------------------------------------------- *
   * Inbox
   * ---------------------------------------------------------------- */

  /**
   * One tab of the inbox. The tabs partition the same table:
   *   primary / other  → live items, split by category
   *   replies          → live items that are conversation (comments, mentions)
   *   later            → snoozed into the future
   *   cleared          → archived
   * "Live" means not archived and not currently snoozed.
   */
  async list(orgId: string, userId: string, tab: InboxTab = "primary") {
    const mine = and(
      eq(notifications.organizationId, orgId),
      eq(notifications.receiverId, userId),
    );
    const live = and(
      isNull(notifications.archivedAt),
      or(isNull(notifications.snoozedTill), sql`${notifications.snoozedTill} <= now()`),
    );

    const where =
      tab === "cleared"
        ? and(mine, isNotNull(notifications.archivedAt))
        : tab === "later"
          ? and(
              mine,
              isNull(notifications.archivedAt),
              gt(notifications.snoozedTill, sql`now()`),
            )
          : tab === "replies"
            ? and(mine, live, inArray(notifications.verb, ["commented", "mentioned"]))
            : and(mine, live, eq(notifications.category, tab));

    const rows = await this.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(200);

    return this.decorate(rows);
  }

  /** Per-tab unread counts for the badges, in one round-trip. */
  async unreadCounts(orgId: string, userId: string) {
    const live = and(
      eq(notifications.organizationId, orgId),
      eq(notifications.receiverId, userId),
      isNull(notifications.readAt),
      isNull(notifications.archivedAt),
      or(isNull(notifications.snoozedTill), sql`${notifications.snoozedTill} <= now()`),
    );
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        primary: sql<number>`count(*) filter (where ${notifications.category} = 'primary')::int`,
        other: sql<number>`count(*) filter (where ${notifications.category} = 'other')::int`,
        replies: sql<number>`count(*) filter (where ${notifications.verb} in ('commented','mentioned'))::int`,
      })
      .from(notifications)
      .where(live);

    return {
      count: row?.total ?? 0,
      primary: row?.primary ?? 0,
      other: row?.other ?? 0,
      replies: row?.replies ?? 0,
    };
  }

  /** Every mutation below is scoped to the receiver — you can only touch yours. */
  async markRead(orgId: string, userId: string, id: string) {
    const [row] = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(this.ownRow(orgId, userId, id))
      .returning();
    return row ?? null;
  }

  async markAllRead(orgId: string, userId: string) {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.organizationId, orgId),
          eq(notifications.receiverId, userId),
          isNull(notifications.readAt),
        ),
      );
    return { ok: true };
  }

  async archive(orgId: string, userId: string, id: string) {
    const [row] = await this.db
      .update(notifications)
      .set({ archivedAt: new Date(), readAt: new Date() })
      .where(this.ownRow(orgId, userId, id))
      .returning();
    return row ?? null;
  }

  /** "Clear all": archive everything live in one tab (or all tabs). */
  async clearAll(orgId: string, userId: string, category?: "primary" | "other") {
    await this.db
      .update(notifications)
      .set({ archivedAt: new Date(), readAt: new Date() })
      .where(
        and(
          eq(notifications.organizationId, orgId),
          eq(notifications.receiverId, userId),
          isNull(notifications.archivedAt),
          ...(category ? [eq(notifications.category, category)] : []),
        ),
      );
    return { ok: true };
  }

  async snooze(orgId: string, userId: string, id: string, until: Date) {
    const [row] = await this.db
      .update(notifications)
      .set({ snoozedTill: until })
      .where(this.ownRow(orgId, userId, id))
      .returning();
    return row ?? null;
  }

  /** Un-snooze, or restore from Cleared, back into the live inbox. */
  async restore(orgId: string, userId: string, id: string) {
    const [row] = await this.db
      .update(notifications)
      .set({ snoozedTill: null, archivedAt: null })
      .where(this.ownRow(orgId, userId, id))
      .returning();
    return row ?? null;
  }

  async toggleImportant(orgId: string, userId: string, id: string) {
    const [row] = await this.db
      .update(notifications)
      .set({ isImportant: sql`not ${notifications.isImportant}` })
      .where(this.ownRow(orgId, userId, id))
      .returning();
    return row ?? null;
  }

  private ownRow(orgId: string, userId: string, id: string) {
    return and(
      eq(notifications.id, id),
      eq(notifications.organizationId, orgId),
      eq(notifications.receiverId, userId),
    );
  }

  /* ---------------------------------------------------------------- *
   * Preferences
   * ---------------------------------------------------------------- */

  async getPreferences(orgId: string, userId: string) {
    const row = await this.db.query.notificationPreferences.findFirst({
      where: and(
        eq(notificationPreferences.organizationId, orgId),
        eq(notificationPreferences.userId, userId),
      ),
    });
    return row ?? { organizationId: orgId, userId, ...DEFAULT_PREFERENCES };
  }

  async updatePreferences(orgId: string, userId: string, patch: Partial<PreferenceFlags>) {
    const [row] = await this.db
      .insert(notificationPreferences)
      .values({ organizationId: orgId, userId, ...DEFAULT_PREFERENCES, ...patch })
      .onConflictDoUpdate({
        target: [notificationPreferences.organizationId, notificationPreferences.userId],
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /**
   * Resolves actors and attaches the reply count for task rows — the little
   * bubble in the inbox that says how much conversation is on the item. Both
   * are batched: one query for actors, one grouped query for counts.
   */
  private async decorate(rows: (typeof notifications.$inferSelect)[]) {
    const actorIds = [...new Set(rows.map((r) => r.triggeredById).filter(Boolean))] as string[];
    const taskIds = [
      ...new Set(rows.filter((r) => r.entityType === "task").map((r) => r.entityId)),
    ];

    const [actors, counts] = await Promise.all([
      actorIds.length
        ? this.db.select().from(users).where(inArray(users.id, actorIds))
        : Promise.resolve([]),
      taskIds.length
        ? this.db
            .select({ taskId: comments.taskId, n: sql<number>`count(*)::int` })
            .from(comments)
            .where(inArray(comments.taskId, taskIds))
            .groupBy(comments.taskId)
        : Promise.resolve([]),
    ]);

    const actorById = new Map(actors.map((a) => [a.id, a]));
    const countByTask = new Map(counts.map((c) => [c.taskId, c.n]));

    return rows.map((r) => {
      const a = r.triggeredById ? actorById.get(r.triggeredById) : undefined;
      return {
        ...r,
        triggeredBy: a ? { id: a.id, name: a.name, avatarUrl: a.avatarUrl } : null,
        replyCount: r.entityType === "task" ? (countByTask.get(r.entityId) ?? 0) : 0,
      };
    });
  }
}
