import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  organizations,
  comments,
  documents,
  follows,
  milestones,
  notificationMutes,
  notificationPreferences,
  notifications,
  projects,
  projectStages,
  taskAssignees,
  tasks,
  users,
} from "../../db/schema.js";
import { ChatEventsService } from "../chat/chat-events.service.js";
import { ChatGateway } from "../chat/chat.gateway.js";
import { MailerService } from "./mailer.service.js";
import { resolveDigest, type DigestPrefs } from "./digest.prefs.js";
import type { FieldChange } from "../activity/activity.service.js";

/**
 * Row 73: every verb rolls up to a notification *type*, and each type has its
 * own in-app / email / push switches per user.
 */
export const NOTIF_TYPES = [
  "mention",
  "assigned",
  "comment",
  "statusChange",
  "propertyChange",
  "taskCompleted",
  "approvals",
  "reminders",
  "chat",
  "following",
] as const;
export type NotifType = (typeof NOTIF_TYPES)[number];
export interface ChannelPrefs {
  inApp: boolean;
  email: boolean;
  push: boolean;
}
export type ChannelMatrix = Record<NotifType, ChannelPrefs>;
/** Row 74: what can be muted. */
export type MutableEntity = "task" | "document" | "project";

/**
 * Row 75: an approval request rides on a notification as `data.approval`.
 * The inbox renders Approve / Reject inline; deciding dispatches to the
 * domain service that registered the kind (docs, milestones, timesheets),
 * then every pending card for that entity flips to the outcome.
 */
export type ApprovalKind = "doc_review" | "milestone" | "timesheet" | "leave";
export interface ApprovalMeta {
  kind: ApprovalKind;
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
  decidedById?: string;
  note?: string | null;
}
export interface ApprovalDecision {
  orgId: string;
  userId: string;
  role: string;
  entityId: string;
  approve: boolean;
  note?: string;
}
type ApprovalHandler = (d: ApprovalDecision) => Promise<unknown>;
export const pendingApproval = (kind: ApprovalKind): ApprovalMeta => ({ kind, status: "pending" });

const TYPE_FOR_VERB: Record<string, NotifType> = {
  mentioned: "mention",
  comment_assigned: "mention",
  assigned: "assigned",
  commented: "comment",
  status_changed: "statusChange",
  updated: "propertyChange",
  completed: "taskCompleted",
  doc_review_requested: "approvals",
  doc_approved: "approvals",
  doc_rejected: "approvals",
  proposal_viewed: "approvals",
  proposal_accepted: "approvals",
  proposal_declined: "approvals",
  timesheet_submitted: "approvals",
  timesheet_approved: "approvals",
  timesheet_rejected: "approvals",
  timesheet_reopened: "approvals",
  leave_requested: "approvals",
  leave_approved: "approvals",
  leave_rejected: "approvals",
  milestone_signoff_requested: "approvals",
  client_approved: "approvals",
  client_changes_requested: "approvals",
  milestone_approved: "approvals",
  milestone_rejected: "approvals",
  due_soon: "reminders",
  overdue: "reminders",
  milestone_at_risk: "reminders",
  integration_failing: "reminders",
  follow_up: "reminders",
  timesheet_reminder: "reminders",
  posted: "chat",
  project_activity: "following",
  doc_edited: "following",
  doc_shared: "following",
  doc_superseded: "following",
};

/** Sensible defaults: everything in-app, the addressed stuff also by email, only the urgent stuff as push. */
const ch = (email: boolean, push: boolean): ChannelPrefs => ({ inApp: true, email, push });
export const DEFAULT_CHANNELS: ChannelMatrix = {
  mention: ch(true, true),
  assigned: ch(true, true),
  comment: ch(false, false),
  statusChange: ch(false, false),
  propertyChange: ch(false, false),
  taskCompleted: ch(false, false),
  approvals: ch(true, true),
  reminders: ch(true, false),
  chat: ch(false, false),
  following: ch(false, false),
};

/** Legacy boolean columns (pre row 73) still seed the in-app switch. */
const LEGACY_FLAG_FOR_TYPE: Partial<Record<NotifType, keyof PreferenceFlags>> = {
  mention: "mention",
  assigned: "propertyChange",
  comment: "comment",
  statusChange: "statusChange",
  propertyChange: "propertyChange",
  taskCompleted: "taskCompleted",
};

type StoredChannels = Record<string, Partial<ChannelPrefs>> | null | undefined;

/** Row 111: quiet hours - no email or push between start and end (local to the timezone); in-app still lands. */
export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" */
  start: string;
  end: string;
  /** Treat all of Saturday and Sunday as quiet. */
  weekends: boolean;
  /** IANA zone, e.g. "Asia/Dhaka". */
  timezone: string;
}
export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: "20:00", end: "08:00", weekends: false, timezone: "Asia/Dhaka" };
export function resolveQuietHours(...layers: (Partial<QuietHours> | null | undefined)[]): QuietHours {
  let out = { ...DEFAULT_QUIET_HOURS };
  for (const l of layers) if (l) out = { ...out, ...l };
  return out;
}
/** Is `now` inside the quiet window? Handles windows that cross midnight (20:00 -> 08:00). */
export function isQuietNow(q: QuietHours, now = new Date()) {
  if (!q.enabled) return false;
  let parts: { weekday: string; hour: string; minute: string };
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: q.timezone || "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
    parts = { weekday: p.weekday ?? "", hour: p.hour ?? "00", minute: p.minute ?? "00" };
  } catch {
    parts = { weekday: now.toUTCString().slice(0, 3), hour: String(now.getUTCHours()).padStart(2, "0"), minute: String(now.getUTCMinutes()).padStart(2, "0") };
  }
  if (q.weekends && (parts.weekday === "Sat" || parts.weekday === "Sun")) return true;
  const mins = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return ((h ?? 0) % 24) * 60 + (m ?? 0);
  };
  const a = toMin(q.start), b = toMin(q.end);
  if (a === b) return false;
  return a < b ? mins >= a && mins < b : mins >= a || mins < b;
}

/** Defaults <- workspace defaults (row 111) <- legacy booleans (in-app) <- stored matrix. */
export function resolveChannels(row: (Partial<PreferenceFlags> & { channels?: StoredChannels }) | null | undefined, orgDefaults?: StoredChannels): ChannelMatrix {
  const out = {} as ChannelMatrix;
  for (const type of NOTIF_TYPES) {
    const base = { ...DEFAULT_CHANNELS[type], ...(orgDefaults?.[type] ?? {}) };
    const legacy = LEGACY_FLAG_FOR_TYPE[type];
    if (row && legacy && typeof row[legacy] === "boolean") base.inApp = row[legacy] as boolean;
    out[type] = { ...base, ...(row?.channels?.[type] ?? {}) };
  }
  return out;
}

/**
 * Verbs that are *addressed to you* rather than ambient. These land in the
 * Primary tab regardless of how the receiver relates to the task. A plain
 * comment is primary only for the task's assignees — for a mere follower it's
 * background noise, so it goes to Other.
 */
const ALWAYS_PRIMARY = new Set(["assigned", "mentioned", "comment_assigned"]);

/**
 * Row 71: the inbox is split by *type* rather than by primary/other.
 *   all        -> every live item
 *   mentions   -> you were @mentioned or assigned a comment
 *   assigned   -> a task was assigned to you
 *   approvals  -> things waiting on (or answering) a sign-off: doc reviews,
 *                 proposal decisions, timesheets...
 *   alerts     -> everything else: follow-ups, status changes, reminders
 *   replies    -> comments and mentions (the Replies section)
 *   later / cleared -> snoozed / archived
 */
export type InboxTab = "all" | "mentions" | "assigned" | "approvals" | "alerts" | "replies" | "later" | "cleared";
export type TypedTab = "mentions" | "assigned" | "approvals" | "alerts";

const TAB_VERBS: Record<Exclude<TypedTab, "alerts">, string[]> = {
  mentions: ["mentioned", "comment_assigned"],
  assigned: ["assigned"],
  approvals: [
    "doc_review_requested",
    "doc_approved",
    "doc_rejected",
    "proposal_accepted",
    "proposal_declined",
    "timesheet_submitted",
    "timesheet_approved",
    "timesheet_rejected",
    "timesheet_reopened",
    "leave_requested",
    "leave_approved",
    "leave_rejected",
    "milestone_signoff_requested",
    "milestone_approved",
    "milestone_rejected",
  ],
};
const TYPED_VERBS = [...TAB_VERBS.mentions, ...TAB_VERBS.assigned, ...TAB_VERBS.approvals];

/** The verb filter for a typed tab; `undefined` means no extra filter (All). */
export function tabVerbFilter(tab: string): SQL | undefined {
  if (tab === "alerts") return notInArray(notifications.verb, TYPED_VERBS);
  const verbs = TAB_VERBS[tab as Exclude<TypedTab, "alerts">];
  return verbs ? inArray(notifications.verb, verbs) : undefined;
}

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
    private readonly mailer: MailerService,
    private readonly chatEvents: ChatEventsService,
  ) {}

  /** Row 77: project followers hear about every project event the chat feed hears about. */
  onModuleInit() {
    this.chatEvents.onProjectEvent((orgId, projectId, actorId, event) =>
      this.notifyFollowers({
        orgId,
        entityType: "project",
        entityId: projectId,
        actorId,
        verb: "project_activity",
        title: event.text,
        data: { projectId, link: event.link ?? `/projects/${projectId}`, eventType: event.type },
      }),
    );
  }

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

      await this.insertAndPush(
        recipients.map((receiverId) => ({
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
      // Row 77: being @mentioned (or handed a comment) on a task makes you a follower.
      if (input.entityType === "task") {
        for (const id of receivers) await this.follow(input.orgId, id, "task", input.entityId, "mentioned");
      }

      await this.insertAndPush(
        receivers.map((receiverId) => ({
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

  /**
   * One addressed notification for something that isn't a task — e.g. a deal
   * follow-up (row 55). No preference gating: the receiver asked for it by
   * setting the date.
   */
  async notifyDirect(input: {
    orgId: string;
    receiverId: string;
    actorId?: string | null;
    entityType: string;
    entityId: string;
    verb: string;
    title: string;
    body?: string | null;
    data?: Record<string, unknown> | null;
    category?: "primary" | "other";
  }) {
    try {
      await this.insertAndPush([
        {
          organizationId: input.orgId,
          receiverId: input.receiverId,
          triggeredById: input.actorId ?? null,
          entityType: input.entityType,
          entityId: input.entityId,
          verb: input.verb,
          category: input.category ?? "primary",
          title: input.title,
          body: input.body ?? null,
          data: input.data ?? null,
        },
      ]);
    } catch (err) {
      this.logger.error(`direct notification failed: ${(err as Error).message}`);
    }
  }

  /**
   * Row 73: the single delivery gate. Each receiver's matrix decides, per type,
   * whether the row lands in the inbox (in-app), goes out by email, and/or is
   * pushed as a desktop notification. Unknown verbs always reach the inbox.
   */
  private async insertAndPush(input: (typeof notifications.$inferInsert)[]) {
    const values = await this.dropMuted(input);
    if (!values.length) return;
    const orgId = values[0]!.organizationId;
    const receiverIds = [...new Set(values.map((v) => v.receiverId))];
    const [prefRows, orgRow] = await Promise.all([
      this.db
        .select()
        .from(notificationPreferences)
        .where(and(eq(notificationPreferences.organizationId, orgId), inArray(notificationPreferences.userId, receiverIds))),
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { notificationDefaults: true, quietHours: true } }),
    ]);
    const matrixFor = new Map(receiverIds.map((id) => [id, resolveChannels(prefRows.find((p) => p.userId === id), orgRow?.notificationDefaults)]));
    // Row 111: quiet hours silence email + push (in-app still lands). Personal window beats the workspace one.
    const now = new Date();
    const quietFor = new Map(receiverIds.map((id) => {
      const mine = prefRows.find((p) => p.userId === id)?.quietHours;
      return [id, isQuietNow(resolveQuietHours(orgRow?.quietHours, mine), now)];
    }));
    const channelsOf = (v: { receiverId: string; verb: string }): ChannelPrefs => {
      const type = TYPE_FOR_VERB[v.verb];
      return type ? matrixFor.get(v.receiverId)![type] : { inApp: true, email: false, push: false };
    };

    const inApp = values.filter((v) => channelsOf(v).inApp);
    const rows = inApp.length ? await this.db.insert(notifications).values(inApp).returning() : [];
    // Push live to anyone with the app open.
    for (const row of rows) {
      this.gateway.emitToUser(row.receiverId, "notification:new", row);
    }

    // Side channels. Email needs the address; push is a socket event the web app
    // turns into a browser notification (no push server needed).
    const wantEmail = values.filter((v) => channelsOf(v).email && !quietFor.get(v.receiverId));
    const wantPush = values.filter((v) => channelsOf(v).push && !quietFor.get(v.receiverId));
    if (wantEmail.length) {
      const people = await this.db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, [...new Set(wantEmail.map((v) => v.receiverId))]));
      const emailOf = new Map(people.map((u) => [u.id, u.email]));
      for (const v of wantEmail) {
        const to = emailOf.get(v.receiverId);
        if (to) void this.mailer.send({ to, subject: v.title, text: v.body ?? v.title, link: linkFor(v) });
      }
    }
    for (const v of wantPush) {
      this.gateway.emitToUser(v.receiverId, "notification:push", { title: v.title, body: v.body ?? "", link: linkFor(v), verb: v.verb });
    }
  }

  /* ---------------------------------------------------------------- *
   * Row 75: approvals
   * ---------------------------------------------------------------- */

  private readonly approvalHandlers = new Map<ApprovalKind, ApprovalHandler>();

  /** Domain services register how a kind gets decided (called from their onModuleInit). */
  registerApproval(kind: ApprovalKind, handler: ApprovalHandler) {
    this.approvalHandlers.set(kind, handler);
  }

  /** Approve / reject straight from the inbox card. */
  async decide(orgId: string, actor: { userId: string; role: string }, id: string, approve: boolean, note?: string) {
    const n = await this.db.query.notifications.findFirst({ where: this.ownRow(orgId, actor.userId, id) });
    const approval = n?.data?.approval as ApprovalMeta | undefined;
    if (!n || !approval) throw new NotFoundException("No approval on this notification");
    if (approval.status !== "pending") throw new BadRequestException("This was already decided");
    const handler = this.approvalHandlers.get(approval.kind);
    if (!handler) throw new BadRequestException(`Nothing handles ${approval.kind} approvals`);
    await handler({ orgId, userId: actor.userId, role: actor.role, entityId: n.entityId, approve, note });
    // The handler normally resolves the cards itself; this is the safety net.
    await this.resolveApproval(n.entityType, n.entityId, approve ? "approved" : "rejected", note, actor.userId);
    const [updated] = await this.decorate([(await this.db.query.notifications.findFirst({ where: this.ownRow(orgId, actor.userId, id) }))!]);
    return updated;
  }

  /** Flip every pending approval card for an entity to its outcome (whoever decided, from wherever). */
  async resolveApproval(entityType: string, entityId: string, status: "approved" | "rejected", note: string | null | undefined, decidedById: string) {
    const rows = await this.db
      .select({ id: notifications.id, data: notifications.data, readAt: notifications.readAt })
      .from(notifications)
      .where(and(eq(notifications.entityType, entityType), eq(notifications.entityId, entityId), sql`${notifications.data}->'approval'->>'status' = 'pending'`));
    const now = new Date();
    for (const row of rows) {
      const approval = { ...(row.data?.approval as ApprovalMeta), status, decidedAt: now.toISOString(), decidedById, note: note?.trim() || null };
      await this.db
        .update(notifications)
        .set({ data: { ...(row.data ?? {}), approval }, readAt: row.readAt ?? now })
        .where(eq(notifications.id, row.id));
    }
  }

  /* ---------------------------------------------------------------- *
   * Row 74: mutes
   * ---------------------------------------------------------------- */

  /**
   * Remove rows whose receiver muted the entity itself or the project it
   * belongs to. Project membership is resolved per entity type: a task via its
   * stage or milestone, a doc via its project, a milestone via the row's data.
   */
  private async dropMuted(values: (typeof notifications.$inferInsert)[]) {
    if (!values.length) return values;
    const receiverIds = [...new Set(values.map((v) => v.receiverId))];
    const mutes = await this.db
      .select({ userId: notificationMutes.userId, entityType: notificationMutes.entityType, entityId: notificationMutes.entityId })
      .from(notificationMutes)
      .where(inArray(notificationMutes.userId, receiverIds));
    if (!mutes.length) return values;
    const muted = new Set(mutes.map((m) => `${m.userId}:${m.entityType}:${m.entityId}`));

    // Resolve each entity's project once, only for the types that live in one.
    const projectOf = new Map<string, string | null>();
    const taskIds = [...new Set(values.filter((v) => v.entityType === "task").map((v) => v.entityId))];
    if (taskIds.length) {
      const rows = await this.db
        .select({ id: tasks.id, stageProject: projectStages.projectId, milestoneProject: milestones.projectId })
        .from(tasks)
        .leftJoin(projectStages, eq(projectStages.id, tasks.stageId))
        .leftJoin(milestones, eq(milestones.id, tasks.milestoneId))
        .where(inArray(tasks.id, taskIds));
      for (const r of rows) projectOf.set(`task:${r.id}`, r.stageProject ?? r.milestoneProject ?? null);
    }
    const docIds = [...new Set(values.filter((v) => v.entityType === "document").map((v) => v.entityId))];
    if (docIds.length) {
      const rows = await this.db.select({ id: documents.id, projectId: documents.projectId }).from(documents).where(inArray(documents.id, docIds));
      for (const r of rows) projectOf.set(`document:${r.id}`, r.projectId);
    }
    for (const v of values) {
      if (v.entityType === "milestone" && typeof v.data?.projectId === "string") projectOf.set(`milestone:${v.entityId}`, v.data.projectId);
      if (v.entityType === "project") projectOf.set(`project:${v.entityId}`, v.entityId);
    }

    return values.filter((v) => {
      if (muted.has(`${v.receiverId}:${v.entityType}:${v.entityId}`)) return false;
      const projectId = projectOf.get(`${v.entityType}:${v.entityId}`);
      return !(projectId && muted.has(`${v.receiverId}:project:${projectId}`));
    });
  }

  /** The caller's mutes, with a display name for each so the list is readable. */
  async listMutes(orgId: string, userId: string) {
    const rows = await this.db
      .select()
      .from(notificationMutes)
      .where(and(eq(notificationMutes.organizationId, orgId), eq(notificationMutes.userId, userId)))
      .orderBy(desc(notificationMutes.createdAt));
    const ids = (t: string) => rows.filter((m) => m.entityType === t).map((m) => m.entityId);
    const [t, d, p] = await Promise.all([
      ids("task").length ? this.db.select({ id: tasks.id, name: tasks.title }).from(tasks).where(inArray(tasks.id, ids("task"))) : [],
      ids("document").length ? this.db.select({ id: documents.id, name: documents.title }).from(documents).where(inArray(documents.id, ids("document"))) : [],
      ids("project").length ? this.db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids("project"))) : [],
    ]);
    const names = new Map([...t, ...d, ...p].map((x) => [x.id, x.name]));
    return rows.map((m) => ({ ...m, name: names.get(m.entityId) ?? "(deleted)" }));
  }

  async mute(orgId: string, userId: string, entityType: MutableEntity, entityId: string) {
    await this.db
      .insert(notificationMutes)
      .values({ organizationId: orgId, userId, entityType, entityId })
      .onConflictDoNothing();
    return { muted: true };
  }

  async unmute(userId: string, entityType: MutableEntity, entityId: string) {
    await this.db
      .delete(notificationMutes)
      .where(and(eq(notificationMutes.userId, userId), eq(notificationMutes.entityType, entityType), eq(notificationMutes.entityId, entityId)));
    return { muted: false };
  }

  private categorise(verb: string, receiverIsAssignee: boolean): "primary" | "other" {
    if (ALWAYS_PRIMARY.has(verb)) return "primary";
    if (verb === "commented" && receiverIsAssignee) return "primary";
    return "other";
  }

  /* ---------------------------------------------------------------- *
   * Row 77: follows (tasks, docs, projects)
   * ---------------------------------------------------------------- */

  async follow(orgId: string, userId: string, entityType: MutableEntity, entityId: string, reason: "manual" | "assigned" | "mentioned" | "created" = "manual") {
    await this.db
      .insert(follows)
      .values({ organizationId: orgId, userId, entityType, entityId, reason })
      .onConflictDoNothing();
    return { following: true };
  }

  async unfollow(userId: string, entityType: MutableEntity, entityId: string) {
    await this.db
      .delete(follows)
      .where(and(eq(follows.userId, userId), eq(follows.entityType, entityType), eq(follows.entityId, entityId)));
    return { following: false };
  }

  async isFollowing(userId: string, entityType: MutableEntity, entityId: string) {
    const row = await this.db.query.follows.findFirst({
      where: and(eq(follows.userId, userId), eq(follows.entityType, entityType), eq(follows.entityId, entityId)),
    });
    return Boolean(row);
  }

  /** Everything I follow, with a display name so the settings list reads well. */
  async listFollows(orgId: string, userId: string) {
    const rows = await this.db
      .select()
      .from(follows)
      .where(and(eq(follows.organizationId, orgId), eq(follows.userId, userId)))
      .orderBy(desc(follows.createdAt));
    const ids = (t: string) => rows.filter((m) => m.entityType === t).map((m) => m.entityId);
    const [t, d, p] = await Promise.all([
      ids("task").length ? this.db.select({ id: tasks.id, name: tasks.title }).from(tasks).where(inArray(tasks.id, ids("task"))) : [],
      ids("document").length ? this.db.select({ id: documents.id, name: documents.title }).from(documents).where(inArray(documents.id, ids("document"))) : [],
      ids("project").length ? this.db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids("project"))) : [],
    ]);
    const names = new Map([...t, ...d, ...p].map((x) => [x.id, x.name]));
    return rows.map((m) => ({ ...m, name: names.get(m.entityId) ?? "(deleted)" }));
  }

  private async followersOf(entityType: MutableEntity, entityId: string) {
    const rows = await this.db.select({ userId: follows.userId }).from(follows).where(and(eq(follows.entityType, entityType), eq(follows.entityId, entityId)));
    return rows.map((r) => r.userId);
  }

  /** Fan an event out to a doc's or project's followers (never the actor). */
  async notifyFollowers(input: {
    orgId: string;
    entityType: "document" | "project";
    entityId: string;
    actorId: string | null;
    verb: string;
    title: string;
    body?: string | null;
    data?: Record<string, unknown> | null;
    exclude?: string[];
  }) {
    try {
      const skip = new Set([input.actorId, ...(input.exclude ?? [])]);
      const receivers = (await this.followersOf(input.entityType, input.entityId)).filter((id) => !skip.has(id));
      if (!receivers.length) return;
      await this.insertAndPush(
        receivers.map((receiverId) => ({
          organizationId: input.orgId,
          receiverId,
          triggeredById: input.actorId,
          entityType: input.entityType,
          entityId: input.entityId,
          verb: input.verb,
          category: "other",
          title: input.title,
          body: input.body ?? null,
          data: input.data ?? null,
        })),
      );
    } catch (err) {
      this.logger.error(`follower fan-out failed for ${input.entityType} ${input.entityId}: ${(err as Error).message}`);
    }
  }

  /** Task wrappers kept for the existing call sites. Assignees are auto-followed. */
  async subscribe(orgId: string, taskId: string, userId: string, reason: "manual" | "assigned" | "mentioned" | "created" = "assigned") {
    await this.follow(orgId, userId, "task", taskId, reason);
  }

  async unsubscribe(taskId: string, userId: string) {
    await this.unfollow(userId, "task", taskId);
  }

  async isSubscribed(taskId: string, userId: string) {
    return this.isFollowing(userId, "task", taskId);
  }

  /**
   * Followers plus assignees (assignment implies interest even if the
   * follow row was never written), minus the person who caused the event.
   * The assignee set is returned too because it decides Primary vs Other.
   */
  private async subscribersOf(taskId: string, actorId: string) {
    const [subs, assigneeRows] = await Promise.all([
      this.followersOf("task", taskId),
      this.db
        .select({ userId: taskAssignees.userId })
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, taskId)),
    ]);

    const assignees = new Set(assigneeRows.map((r) => r.userId));
    const ids = new Set([...subs, ...assignees]);
    ids.delete(actorId);
    return { recipients: [...ids], assignees };
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
  async list(orgId: string, userId: string, tab: InboxTab = "all") {
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
            : and(mine, live, tabVerbFilter(tab));

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
        mentions: sql<number>`count(*) filter (where ${inArray(notifications.verb, TAB_VERBS.mentions)})::int`,
        assigned: sql<number>`count(*) filter (where ${inArray(notifications.verb, TAB_VERBS.assigned)})::int`,
        approvals: sql<number>`count(*) filter (where ${inArray(notifications.verb, TAB_VERBS.approvals)})::int`,
        alerts: sql<number>`count(*) filter (where ${notInArray(notifications.verb, TYPED_VERBS)})::int`,
        replies: sql<number>`count(*) filter (where ${notifications.verb} in ('commented','mentioned'))::int`,
      })
      .from(notifications)
      .where(live);

    return {
      count: row?.total ?? 0,
      all: row?.total ?? 0,
      mentions: row?.mentions ?? 0,
      assigned: row?.assigned ?? 0,
      approvals: row?.approvals ?? 0,
      alerts: row?.alerts ?? 0,
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

  /** Row 71: "Mark all read" - everything, or just the open tab. */
  async markAllRead(orgId: string, userId: string, tab?: TypedTab | "all") {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.organizationId, orgId),
          eq(notifications.receiverId, userId),
          isNull(notifications.readAt),
          tab ? tabVerbFilter(tab) : undefined,
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
  async clearAll(orgId: string, userId: string, tab?: TypedTab | "all") {
    await this.db
      .update(notifications)
      .set({ archivedAt: new Date(), readAt: new Date() })
      .where(
        and(
          eq(notifications.organizationId, orgId),
          eq(notifications.receiverId, userId),
          isNull(notifications.archivedAt),
          tab ? tabVerbFilter(tab) : undefined,
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

  /** Row 73: the resolved per-type channel matrix for this user. */
  async getPreferences(orgId: string, userId: string) {
    const row = await this.db.query.notificationPreferences.findFirst({
      where: and(
        eq(notificationPreferences.organizationId, orgId),
        eq(notificationPreferences.userId, userId),
      ),
    });
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { notificationDefaults: true, quietHours: true } });
    return {
      channels: resolveChannels(row, org?.notificationDefaults),
      digest: resolveDigest(row?.digest),
      emailConfigured: this.mailer.configured,
      quietHours: row?.quietHours ?? null,
      workspaceQuietHours: resolveQuietHours(org?.quietHours),
    };
  }

  /* ---------------- Row 111: workspace defaults ---------------- */

  async getWorkspaceDefaults(orgId: string) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { notificationDefaults: true, quietHours: true } });
    return { channels: resolveChannels(null, org?.notificationDefaults), quietHours: resolveQuietHours(org?.quietHours), emailConfigured: this.mailer.configured };
  }

  async updateWorkspaceDefaults(orgId: string, patch: { channels?: Partial<Record<NotifType, Partial<ChannelPrefs>>>; quietHours?: Partial<QuietHours> }) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { notificationDefaults: true, quietHours: true } });
    const current = resolveChannels(null, org?.notificationDefaults);
    const next = { ...current } as ChannelMatrix;
    for (const type of NOTIF_TYPES) if (patch.channels?.[type]) next[type] = { ...current[type], ...patch.channels[type] };
    const quiet = resolveQuietHours(org?.quietHours, patch.quietHours);
    await this.db.update(organizations).set({ notificationDefaults: next, quietHours: quiet, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    return { channels: next, quietHours: quiet, emailConfigured: this.mailer.configured };
  }

  /** Merge a partial matrix (`{ mention: { email: false } }`) into the stored one. */
  async updatePreferences(orgId: string, userId: string, patch: Partial<Record<NotifType, Partial<ChannelPrefs>>> & { digest?: Partial<DigestPrefs>; quietHours?: Partial<QuietHours> | null }) {
    const [current, org] = await Promise.all([
      this.db.query.notificationPreferences.findFirst({
        where: and(eq(notificationPreferences.organizationId, orgId), eq(notificationPreferences.userId, userId)),
      }),
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { notificationDefaults: true, quietHours: true } }),
    ]);
    const resolved = resolveChannels(current, org?.notificationDefaults);
    // Row 111: personal quiet hours (null clears the override so the workspace window applies).
    const quietHours = patch.quietHours === undefined ? (current?.quietHours ?? null) : patch.quietHours === null ? null : resolveQuietHours(org?.quietHours, current?.quietHours, patch.quietHours);
    const next = { ...resolved } as ChannelMatrix;
    for (const type of NOTIF_TYPES) {
      if (patch[type]) next[type] = { ...resolved[type], ...patch[type] };
    }
    // Row 76: the digest schedule lives beside the matrix.
    const digest = resolveDigest({ ...(current?.digest ?? {}), ...(patch.digest ?? {}) });
    await this.db
      .insert(notificationPreferences)
      .values({ organizationId: orgId, userId, ...DEFAULT_PREFERENCES, channels: next, digest, quietHours })
      .onConflictDoUpdate({
        target: [notificationPreferences.organizationId, notificationPreferences.userId],
        set: { channels: next, digest, quietHours, updatedAt: new Date() },
      });
    return { channels: next, digest, emailConfigured: this.mailer.configured, quietHours, workspaceQuietHours: resolveQuietHours(org?.quietHours) };
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


/** Where a notification points in the web app - used for email and push. */
function linkFor(v: { entityType: string; entityId: string; data?: Record<string, unknown> | null }): string | undefined {
  const d = v.data ?? {};
  switch (v.entityType) {
    case "task":
      return `/t/${v.entityId}`;
    case "document":
      return `/docs/${v.entityId}`;
    case "proposal":
      return `/crm/proposals/${v.entityId}`;
    case "deal":
      return `/crm/deals?deal=${v.entityId}`;
    case "milestone":
      return typeof d.projectId === "string" ? `/projects/${d.projectId}` : undefined;
    case "message":
      return typeof d.channelId === "string" ? `/chat/${d.channelId}` : undefined;
    default:
      return "/inbox";
  }
}
