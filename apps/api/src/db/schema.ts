/**
 * PM Tool — multi-tenant data model (Drizzle / PostgreSQL)
 *
 * Hierarchy (ClickUp-style):
 *   Organization ─┬─ Space ─┬─ Folder ─┬─ List ─┬─ Task ─┬─ Subtask (task.parent_task_id)
 *                 │         └─────────── List ──┘        └─ Comment / Attachment / CustomFieldValue
 *                 └─ Membership (user ↔ org, with role)
 *
 * Tenancy rule: EVERY row below carries `organization_id`. That single column is the
 * tenant boundary — application queries always filter by it, and it is the natural key
 * for Postgres Row-Level Security policies when you turn them on. Scaling path: one
 * primary handles writes, read-replicas serve reads, and if a single org grows huge you
 * shard by `organization_id`.
 */
import { AnyPgColumn, boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */
export const membershipRole = pgEnum("membership_role", [
  "owner",
  "admin",
  "member",
  "guest",
]);

/** The four buckets ClickUp groups custom statuses into for reporting. */
export const statusCategory = pgEnum("status_category", [
  "not_started",
  "active",
  "done",
  "closed",
]);

/** Row 36: how often a task repeats; the next instance is created when the current one is done. */
export const recurrenceFreq = pgEnum("recurrence_freq", ["daily", "weekly", "monthly"]);

export const taskPriority = pgEnum("task_priority", [
  "urgent",
  "high",
  "normal",
  "low",
]);

/* ------------------------------------------------------------------ *
 * Reusable column bundles
 * ------------------------------------------------------------------ */
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
};

/* ------------------------------------------------------------------ *
 * Identity & tenancy
 * ------------------------------------------------------------------ */

/** Global user record. `authSubject` is the `sub` claim from the managed auth
 *  provider (Clerk / Auth0 / Supabase) — we never store passwords ourselves. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authSubject: varchar("auth_subject", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    avatarUrl: text("avatar_url"),
    /** Row 81: set once the user verified a TOTP factor (Supabase MFA). Null = no 2FA. */
    mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_auth_subject_uq").on(t.authSubject),
    uniqueIndex("users_email_uq").on(t.email),
  ],
);

/** Tenant root — a ClickUp "Workspace". */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 64 }).notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    /** Row 67: branding on exports and client pages. */
    brandColor: varchar("brand_color", { length: 16 }).notNull().default("#6366f1"),
    brandLogoUrl: text("brand_logo_url"),
    brandFooter: varchar("brand_footer", { length: 255 }),
    /** Row 108: browser-tab icon for the app (falls back to a generated initials icon in the accent colour). */
    brandFaviconUrl: text("brand_favicon_url"),
    /** Row 80: Google Workspace domain - a verified Google sign-in on this domain auto-joins as member. */
    ssoDomain: varchar("sso_domain", { length: 255 }),
    /** Row 81: roles that must have 2FA enrolled before they can use the workspace. */
    mfaRequiredRoles: jsonb("mfa_required_roles").$type<string[]>().notNull().default([]),
    /** Row 94: when to nudge people whose week is incomplete. Weekday 0-6 (Sun-Sat), local hour. Null = defaults (Fri 16:00, Mon 09:00). */
    timesheetReminders: jsonb("timesheet_reminders").$type<{ weekday: number; hour: number; week: "current" | "previous" }[]>(),
    /** Row 106: a milestone this many days out with open linked tasks is "at risk". */
    milestoneRiskDays: integer("milestone_risk_days").notNull().default(7),
    /** Row 110: standard week for people without their own numbers. Working days are 0-6 (Sun-Sat). */
    standardWeeklyHours: integer("standard_weekly_hours").notNull().default(40),
    workingDays: jsonb("working_days").$type<number[]>().notNull().default([1, 2, 3, 4, 5]),
    /** Row 111: workspace-wide channel defaults per event type, and quiet hours (no email/push) for everyone. */
    notificationDefaults: jsonb("notification_defaults").$type<Record<string, { inApp?: boolean; email?: boolean; push?: boolean }>>(),
    quietHours: jsonb("quiet_hours").$type<{ enabled: boolean; start: string; end: string; weekends: boolean; timezone: string }>(),
    /** Row 107: how the four priority levels are named and coloured in this workspace. */
    priorityLabels: jsonb("priority_labels").$type<Partial<Record<"urgent" | "high" | "normal" | "low", { label: string; color: string }>>>(),
    ...timestamps,
  },
  (t) => [uniqueIndex("organizations_slug_uq").on(t.slug)],
);

/** User ↔ Organization join with role. The multi-tenant access pivot. */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull().default("member"),
    /** Hours per week this person is available for resourcing. */
    weeklyCapacityHours: integer("weekly_capacity_hours").notNull().default(40),
    /** Row 110: part-timers and contractors - their own working days (0-6) and employment type. Null = workspace default. */
    workingDays: jsonb("member_working_days").$type<number[]>(),
    employmentType: varchar("employment_type", { length: 16 }).notNull().default("full_time"),
    /** Row 86: offboarding. Access ends at `endDate` (or immediately when `deactivatedAt` is set with no end date). */
    endDate: timestamp("end_date", { withTimezone: true }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedById: uuid("deactivated_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.organizationId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

/* ------------------------------------------------------------------ *
 * Hierarchy: Space → Folder → List → Task
 * ------------------------------------------------------------------ */

export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    color: varchar("color", { length: 16 }),
    position: doublePrecision("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("spaces_org_idx").on(t.organizationId)],
);

/** Optional grouping layer. A List may live directly in a Space (folderId null)
 *  or inside a Folder — exactly like ClickUp. */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    position: doublePrecision("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("folders_space_idx").on(t.spaceId)],
);

export const lists = pgTable(
  "lists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    position: doublePrecision("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("lists_space_idx").on(t.spaceId),
    index("lists_folder_idx").on(t.folderId),
  ],
);

/** Custom workflow statuses, scoped to a Space (ClickUp statuses live on the Space
 *  and are inherited by its Lists). `category` drives reporting; `position` orders
 *  the board columns. */
export const statuses = pgTable(
  "statuses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    color: varchar("color", { length: 16 }).notNull().default("#6b7280"),
    category: statusCategory("category").notNull().default("not_started"),
    position: doublePrecision("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("statuses_space_idx").on(t.spaceId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    /** Self-reference → subtasks. Null = top-level task. */
    parentTaskId: uuid("parent_task_id"),
    /** Project stage this task is filed under (row 26). */
    stageId: uuid("stage_id").references((): AnyPgColumn => projectStages.id, { onDelete: "set null" }),
    /** Milestone this task counts toward (row 32). */
    milestoneId: uuid("milestone_id").references((): AnyPgColumn => milestones.id, { onDelete: "set null" }),
    /** Repeat rule (row 36): null = one-off. Interval = every N days/weeks/months. */
    recurrence: recurrenceFreq("recurrence"),
    recurrenceInterval: integer("recurrence_interval").notNull().default(1),
    /** The task this one was spawned from, so a series can be traced. */
    recurredFromId: uuid("recurred_from_id"),
    /** Row 47: the chat message this task was created from. */
    sourceMessageId: uuid("source_message_id").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    /** CRM links (row 38): follow-ups show up on the client's page. */
    companyId: uuid("company_id").references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references((): AnyPgColumn => contacts.id, { onDelete: "set null" }),
    dealId: uuid("deal_id").references((): AnyPgColumn => deals.id, { onDelete: "set null" }),
    statusId: uuid("status_id").references(() => statuses.id),
    /** Short human key like "PM-142", unique per org. */
    reference: varchar("reference", { length: 32 }),
    title: text("title").notNull(),
    description: text("description"),
    priority: taskPriority("priority"),
    position: doublePrecision("position").notNull().default(0),
    startDate: timestamp("start_date", { withTimezone: true }),
    dueDate: timestamp("due_date", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    timeEstimateMinutes: integer("time_estimate_minutes"),
    /** Row 119: shown on the client portal when true (default off). tasks_client_visible */
    clientVisible: boolean("client_visible").notNull().default(false),
    /** Row 126: "clickup:<task id>" for imported tasks, so a second import of the same export skips them. */
    importKey: varchar("import_key", { length: 80 }),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("tasks_list_idx").on(t.listId),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_status_idx").on(t.statusId),
    index("tasks_stage_idx").on(t.stageId),
    index("tasks_milestone_idx").on(t.milestoneId),
    index("tasks_company_idx").on(t.companyId),
    index("tasks_source_message_idx").on(t.sourceMessageId),
    index("tasks_contact_idx").on(t.contactId),
    index("tasks_deal_idx").on(t.dealId),
    // Hot path: "give me this org's tasks" — org first, then list.
    index("tasks_org_list_idx").on(t.organizationId, t.listId),
    uniqueIndex("tasks_org_reference_uq").on(t.organizationId, t.reference),
  ],
);

/* ------------------------------------------------------------------ *
 * Task collaborators: assignees, tags, comments, attachments
 * ------------------------------------------------------------------ */

export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("task_assignees_pk").on(t.taskId, t.userId),
    index("task_assignees_user_idx").on(t.userId),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Legacy: tags used to belong to a space. Workspace tags (row 30) leave this null. */
    spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "set null" }),
    name: varchar("name", { length: 64 }).notNull(),
    color: varchar("color", { length: 16 }).notNull().default("#6b7280"),
    ...timestamps,
  },
  (t) => [uniqueIndex("tags_org_name_uq").on(t.organizationId, t.name)],
);

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("task_tags_pk").on(t.taskId, t.tagId)],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    /** Threaded replies. */
    parentCommentId: uuid("parent_comment_id"),
    body: text("body").notNull(),
    /** A comment can be handed to someone as an action item and later resolved. */
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedById: uuid("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("comments_task_idx").on(t.taskId),
    // "Assigned comments" inbox: mine, still open.
    index("comments_assignee_open_idx").on(t.assigneeId, t.resolvedAt),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Exactly one home: a task, or a chat channel (row 43) — and, once sent, the message. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    /** Row 13: images and files dropped into a doc. */
    documentId: uuid("document_id").references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").references((): AnyPgColumn => channels.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references((): AnyPgColumn => messages.id, { onDelete: "cascade" }),
    uploadedById: uuid("uploaded_by_id")
      .notNull()
      .references(() => users.id),
    filename: varchar("filename", { length: 512 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Object key in the S3-compatible bucket (R2/S3) — bytes never hit the app tier. */
    storageKey: text("storage_key").notNull(),
    ...timestamps,
  },
  (t) => [index("attachments_task_idx").on(t.taskId), index("attachments_channel_idx").on(t.channelId), index("attachments_message_idx").on(t.messageId)],
);

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  task: one(tasks, { fields: [attachments.taskId], references: [tasks.id] }),
  channel: one(channels, { fields: [attachments.channelId], references: [channels.id] }),
  message: one(messages, { fields: [attachments.messageId], references: [messages.id] }),
  uploader: one(users, { fields: [attachments.uploadedById], references: [users.id] }),
}));

/* ------------------------------------------------------------------ *
 * Custom fields (schema + values)
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Activity log (audit trail feeding notifications & "recent activity")
 * ------------------------------------------------------------------ */
export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id),
    entityType: varchar("entity_type", { length: 32 }).notNull(), // "task" | "list" | ...
    entityId: uuid("entity_id").notNull(),
    action: varchar("action", { length: 32 }).notNull(), // "created" | "updated" | ...
    changes: jsonb("changes").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("activity_entity_idx").on(t.entityType, t.entityId),
    index("activity_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ *
 * Relations (Drizzle relational query API)
 * ------------------------------------------------------------------ */
export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  memberships: many(memberships),
  spaces: many(spaces),
  owner: one(users, { fields: [organizations.ownerId], references: [users.id] }),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const spacesRelations = relations(spaces, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [spaces.organizationId],
    references: [organizations.id],
  }),
  folders: many(folders),
  lists: many(lists),
  statuses: many(statuses),
}));

export const foldersRelations = relations(folders, ({ many, one }) => ({
  space: one(spaces, { fields: [folders.spaceId], references: [spaces.id] }),
  lists: many(lists),
}));

export const listsRelations = relations(lists, ({ many, one }) => ({
  space: one(spaces, { fields: [lists.spaceId], references: [spaces.id] }),
  folder: one(folders, { fields: [lists.folderId], references: [folders.id] }),
  tasks: many(tasks),
}));

export const statusesRelations = relations(statuses, ({ one, many }) => ({
  space: one(spaces, { fields: [statuses.spaceId], references: [spaces.id] }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  list: one(lists, { fields: [tasks.listId], references: [lists.id] }),
  status: one(statuses, { fields: [tasks.statusId], references: [statuses.id] }),
  stage: one(projectStages, { fields: [tasks.stageId], references: [projectStages.id] }),
  milestone: one(milestones, { fields: [tasks.milestoneId], references: [milestones.id] }),
  company: one(companies, { fields: [tasks.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [tasks.contactId], references: [contacts.id] }),
  deal: one(deals, { fields: [tasks.dealId], references: [deals.id] }),
  sourceMessage: one(messages, { fields: [tasks.sourceMessageId], references: [messages.id] }),
  parent: one(tasks, { fields: [tasks.parentTaskId], references: [tasks.id], relationName: "subtasks" }),
  subtasks: many(tasks, { relationName: "subtasks" }),
  assignees: many(taskAssignees),
  taskTags: many(taskTags),
  comments: many(comments),
  attachments: many(attachments),
}));

export const taskTagsRelations = relations(taskTags, ({ one }) => ({
  task: one(tasks, { fields: [taskTags.taskId], references: [tasks.id] }),
  tag: one(tags, { fields: [taskTags.tagId], references: [tags.id] }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  taskTags: many(taskTags),
}));

export const taskAssigneesRelations = relations(taskAssignees, ({ one }) => ({
  task: one(tasks, { fields: [taskAssignees.taskId], references: [tasks.id] }),
  user: one(users, { fields: [taskAssignees.userId], references: [users.id] }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  task: one(tasks, { fields: [comments.taskId], references: [tasks.id] }),
  author: one(users, {
    fields: [comments.authorId],
    references: [users.id],
    relationName: "comment_author",
  }),
  assignee: one(users, {
    fields: [comments.assigneeId],
    references: [users.id],
    relationName: "comment_assignee",
  }),
}));

/* ------------------------------------------------------------------ *
 * Inferred TypeScript types (shared with the API layer)
 * ------------------------------------------------------------------ */
export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Space = typeof spaces.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type List = typeof lists.$inferSelect;
export type Status = typeof statuses.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;

/* ================================================================== *
 * CHAT  (channels + direct messages, real-time via WS gateway)
 * ================================================================== */
export const channelType = pgEnum("channel_type", ["channel", "dm"]);
/** Row 45: per-member notification rule for a channel. */
export const channelNotify = pgEnum("channel_notify", ["all", "mentions", "muted"]);
/** Row 50: a person wrote it, or the system posted a project event. */
export const messageKind = pgEnum("message_kind", ["user", "system"]);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: channelType("type").notNull().default("channel"),
    /** Null for DMs (name is derived from the members on the client). */
    name: varchar("name", { length: 120 }),
    topic: text("topic"),
    isPrivate: boolean("is_private").notNull().default(false),
    /** Row 39: the project this channel belongs to. Membership mirrors the project team. */
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    /** Row 50: post project events (task done, stage, milestone, doc) as system messages. */
    activityFeed: boolean("activity_feed").notNull().default(true),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("channels_org_idx").on(t.organizationId), uniqueIndex("channels_project_uq").on(t.projectId)],
);

export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    /** all = every message lands in my inbox; mentions = only @me/@channel/@here; muted = nothing, no badge. */
    notify: channelNotify("notify").notNull().default("mentions"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("channel_members_pk").on(t.channelId, t.userId),
    index("channel_members_user_idx").on(t.userId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    /** Row 50: system lines carry the actor as author plus event details in `meta`. */
    kind: messageKind("kind").notNull().default("user"),
    meta: jsonb("meta").$type<{ type: string; link?: string; entityId?: string }>(),
    /** Threaded replies (optional). */
    parentMessageId: uuid("parent_message_id"),
    /** Row 46: pinned to the channel header's Pins panel. */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedById: uuid("pinned_by_id").references(() => users.id, { onDelete: "set null" }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("messages_channel_created_idx").on(t.channelId, t.createdAt)],
);

/** Row 46: links that live in a channel's header — brief, Figma, staging URL. */
export const channelBookmarks = pgTable(
  "channel_bookmarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 120 }).notNull(),
    url: text("url").notNull(),
    position: doublePrecision("position").notNull().default(0),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("channel_bookmarks_channel_idx").on(t.channelId)],
);

export const channelBookmarksRelations = relations(channelBookmarks, ({ one }) => ({
  channel: one(channels, { fields: [channelBookmarks.channelId], references: [channels.id] }),
}));

export const channelsRelations = relations(channels, ({ many, one }) => ({
  bookmarks: many(channelBookmarks),
  organization: one(organizations, {
    fields: [channels.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, { fields: [channels.projectId], references: [projects.id] }),
  members: many(channelMembers),
  messages: many(messages),
}));

export const channelMembersRelations = relations(channelMembers, ({ one }) => ({
  channel: one(channels, { fields: [channelMembers.channelId], references: [channels.id] }),
  user: one(users, { fields: [channelMembers.userId], references: [users.id] }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  channel: one(channels, { fields: [messages.channelId], references: [channels.id] }),
  author: one(users, { fields: [messages.authorId], references: [users.id] }),
}));

export type Channel = typeof channels.$inferSelect;
export type Message = typeof messages.$inferSelect;

/* ================================================================== *
 * Collaboration layer
 *
 * Design borrowed (not copied) from Plane's data model. The through-line:
 * every meaningful change writes one `activity_log` row, and notifications
 * are *derived* from those rows rather than emitted ad-hoc at each call site.
 * That keeps "what happened" and "who was told" from drifting apart.
 * ================================================================== */

export const taskRelation = pgEnum("task_relation", [
  "blocks",
  "blocked_by",
  "duplicates",
  "relates_to",
]);

export const intakeStatus = pgEnum("intake_status", [
  "pending",
  "accepted",
  "rejected",
  "snoozed",
  "duplicate",
]);

/** What a reaction can hang off. Kept as an enum rather than a FK so one table
 *  serves tasks, comments and chat messages alike. */
export const reactionEntity = pgEnum("reaction_entity", ["task", "comment", "message"]);

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

/** One row per (person, event). `snoozedTill` lets someone defer an item without
 *  losing it; `archivedAt` clears it from the inbox without deleting history. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    receiverId: uuid("receiver_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null when the system itself generated it (e.g. a due-date sweep). */
    triggeredById: uuid("triggered_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    /** Mirrors activity_log.action - "assigned", "commented", "mentioned". */
    verb: varchar("verb", { length: 32 }).notNull(),
    /** "primary" = addressed to you (assigned, mentioned, replied to);
     *  "other" = ambient updates on things you follow. Drives the inbox tabs. */
    category: varchar("category", { length: 16 }).notNull().default("other"),
    /** The red flag: the receiver marked it as important. */
    isImportant: boolean("is_important").notNull().default(false),
    title: text("title").notNull(),
    body: text("body"),
    /** Denormalised extras so the inbox renders without extra round-trips. */
    data: jsonb("data").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    snoozedTill: timestamp("snoozed_till", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The inbox query: mine, newest first.
    index("notifications_receiver_created_idx").on(t.receiverId, t.createdAt),
    index("notifications_entity_idx").on(t.entityType, t.entityId),
  ],
);

/** Per-user, per-org opt-outs. An absent row means everything is on. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    propertyChange: boolean("property_change").notNull().default(true),
    statusChange: boolean("status_change").notNull().default(true),
    comment: boolean("comment").notNull().default(true),
    mention: boolean("mention").notNull().default(true),
    taskCompleted: boolean("task_completed").notNull().default(true),
    /**
     * Row 73: per-type channel matrix - `{ mention: { inApp, email, push }, ... }`.
     * Null = defaults (the legacy booleans above still seed the in-app column).
     */
    channels: jsonb("channels").$type<Record<string, { inApp?: boolean; email?: boolean; push?: boolean }>>(),
    /** Row 76: `{ frequency: off|daily|weekly, hour, weekday, inApp, email }`. Null = off. */
    digest: jsonb("digest").$type<{ frequency?: "off" | "daily" | "weekly"; hour?: number; weekday?: number; inApp?: boolean; email?: boolean }>(),
    digestLastSentAt: timestamp("digest_last_sent_at", { withTimezone: true }),
    /** Row 111: personal quiet hours; null = follow the workspace. */
    quietHours: jsonb("quiet_hours").$type<{ enabled: boolean; start: string; end: string; weekends: boolean; timezone: string }>(),
    ...timestamps,
  },
  (t) => [uniqueIndex("notification_prefs_org_user_uq").on(t.organizationId, t.userId)],
);

/** Who follows a task. Assigning someone subscribes them automatically; they can
 *  unsubscribe without being unassigned. */
export const taskSubscribers = pgTable(
  "task_subscribers",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("task_subscribers_pk").on(t.taskId, t.userId),
    index("task_subscribers_user_idx").on(t.userId),
  ],
);

/* ------------------------------------------------------------------ *
 * Task graph and reactions
 * ------------------------------------------------------------------ */

/** Non-hierarchical links between tasks (the hierarchy is tasks.parentTaskId).
 *  The service writes the mirrored row too, so both tasks show the link. */
export const taskRelations = pgTable(
  "task_relations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    relatedTaskId: uuid("related_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    relation: taskRelation("relation").notNull(),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("task_relations_uq").on(t.taskId, t.relatedTaskId, t.relation),
    index("task_relations_task_idx").on(t.taskId),
  ],
);

/** Emoji reactions for tasks, comments and chat messages in one table. */
export const reactions = pgTable(
  "reactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entityType: reactionEntity("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    emoji: varchar("emoji", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One of each emoji per person per thing - clicking again removes it.
    uniqueIndex("reactions_uq").on(t.userId, t.entityType, t.entityId, t.emoji),
    index("reactions_entity_idx").on(t.entityType, t.entityId),
  ],
);

/* ------------------------------------------------------------------ *
 * Cycles (sprints)
 * ------------------------------------------------------------------ */

export const cycles = pgTable(
  "cycles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    startDate: timestamp("start_date", { withTimezone: true }),
    endDate: timestamp("end_date", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("cycles_space_idx").on(t.spaceId)],
);

/** A task belongs to at most one cycle at a time - hence the unique on taskId. */
export const cycleTasks = pgTable(
  "cycle_tasks",
  {
    cycleId: uuid("cycle_id")
      .notNull()
      .references(() => cycles.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("cycle_tasks_task_uq").on(t.taskId),
    index("cycle_tasks_cycle_idx").on(t.cycleId),
  ],
);

/* ------------------------------------------------------------------ *
 * Saved views
 * ------------------------------------------------------------------ */

/** A named, reusable filter set. Scoped to a list, or space-wide when listId is
 *  null. `filters` holds the same shape the toolbar builds, so saving a view is
 *  literally persisting current UI state. */
export const views = pgTable(
  "views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
    listId: uuid("list_id").references(() => lists.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 128 }).notNull(),
    /** "list" | "board" | "table" - which tab the view reopens in. */
    layout: varchar("layout", { length: 16 }).notNull().default("list"),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
    /** Private to its creator unless shared with the whole org. */
    isShared: boolean("is_shared").notNull().default(false),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    index("views_list_idx").on(t.listId),
    index("views_creator_idx").on(t.createdById),
  ],
);

/* ------------------------------------------------------------------ *
 * Intake / triage - the queue behind "Suggestion & Feedback"
 * ------------------------------------------------------------------ */

/** A triage queue attached to a Space. Submissions land here as tasks that stay
 *  out of the normal lists until someone accepts them. */
export const intakes = pgTable(
  "intakes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull().default("Intake"),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    /** Where accepted items go. */
    targetListId: uuid("target_list_id").references(() => lists.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [index("intakes_space_idx").on(t.spaceId)],
);

export const intakeItems = pgTable(
  "intake_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    intakeId: uuid("intake_id")
      .notNull()
      .references(() => intakes.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    status: intakeStatus("status").notNull().default("pending"),
    /** Set when status is snoozed; the item reappears after this. */
    snoozedTill: timestamp("snoozed_till", { withTimezone: true }),
    /** Set when status is duplicate - points at the surviving task. */
    duplicateToTaskId: uuid("duplicate_to_task_id"),
    /** "in_app" | "email" | "form" - where the submission came from. */
    source: varchar("source", { length: 32 }).notNull().default("in_app"),
    sourceEmail: varchar("source_email", { length: 320 }),
    extra: jsonb("extra").$type<Record<string, unknown>>(),
    triagedById: uuid("triaged_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("intake_items_task_uq").on(t.taskId),
    index("intake_items_intake_status_idx").on(t.intakeId, t.status),
  ],
);

/* ------------------------------------------------------------------ *
 * Relations for the new tables
 * ------------------------------------------------------------------ */

export const notificationsRelations = relations(notifications, ({ one }) => ({
  receiver: one(users, {
    fields: [notifications.receiverId],
    references: [users.id],
    relationName: "notification_receiver",
  }),
  triggeredBy: one(users, {
    fields: [notifications.triggeredById],
    references: [users.id],
    relationName: "notification_actor",
  }),
}));

export const taskSubscribersRelations = relations(taskSubscribers, ({ one }) => ({
  task: one(tasks, { fields: [taskSubscribers.taskId], references: [tasks.id] }),
  user: one(users, { fields: [taskSubscribers.userId], references: [users.id] }),
}));

export const taskRelationsRelations = relations(taskRelations, ({ one }) => ({
  task: one(tasks, {
    fields: [taskRelations.taskId],
    references: [tasks.id],
    relationName: "relations_from",
  }),
  relatedTask: one(tasks, {
    fields: [taskRelations.relatedTaskId],
    references: [tasks.id],
    relationName: "relations_to",
  }),
}));

export const reactionsRelations = relations(reactions, ({ one }) => ({
  user: one(users, { fields: [reactions.userId], references: [users.id] }),
}));

export const cyclesRelations = relations(cycles, ({ many, one }) => ({
  space: one(spaces, { fields: [cycles.spaceId], references: [spaces.id] }),
  tasks: many(cycleTasks),
}));

export const cycleTasksRelations = relations(cycleTasks, ({ one }) => ({
  cycle: one(cycles, { fields: [cycleTasks.cycleId], references: [cycles.id] }),
  task: one(tasks, { fields: [cycleTasks.taskId], references: [tasks.id] }),
}));

export const viewsRelations = relations(views, ({ one }) => ({
  createdBy: one(users, { fields: [views.createdById], references: [users.id] }),
}));

export const intakesRelations = relations(intakes, ({ many, one }) => ({
  space: one(spaces, { fields: [intakes.spaceId], references: [spaces.id] }),
  items: many(intakeItems),
}));

export const intakeItemsRelations = relations(intakeItems, ({ one }) => ({
  intake: one(intakes, { fields: [intakeItems.intakeId], references: [intakes.id] }),
  task: one(tasks, { fields: [intakeItems.taskId], references: [tasks.id] }),
  triagedBy: one(users, { fields: [intakeItems.triagedById], references: [users.id] }),
}));

export type Notification = typeof notifications.$inferSelect;
export type TaskRelationRow = typeof taskRelations.$inferSelect;
export type Cycle = typeof cycles.$inferSelect;
export type ViewRow = typeof views.$inferSelect;
export type IntakeItem = typeof intakeItems.$inferSelect;

/* ================================================================== *
 * Productivity layer: projects, time tracking, resourcing
 *
 * A Project is the client-facing unit of work (Bonsai's model). Rather than
 * invent a parallel task hierarchy, a project *wraps a Space*: every list and
 * task in that space belongs to the project. Time is tracked against a project
 * (and optionally a task in it), and resourcing plans hours per person per
 * project per week against their weekly capacity.
 * ================================================================== */

export const projectStatus = pgEnum("project_status", [
  "active",
  "on_hold",
  "completed",
  "archived",
]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The space whose lists/tasks make up this project. One space per project. */
    spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "set null" }),
    name: varchar("name", { length: 255 }).notNull(),
    /** Display name of the client; mirrors the linked company's name when `companyId` is set. */
    clientName: varchar("client_name", { length: 255 }),
    /** CRM company this project is for (row 25). */
    companyId: uuid("company_id").references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
    /** The person accountable for the project. */
    leadId: uuid("lead_id").references(() => users.id, { onDelete: "set null" }),
    /** Row 78: secret part of the project's email-in address. Null until first requested. */
    inboundToken: varchar("inbound_token", { length: 32 }),
    description: text("description"),
    status: projectStatus("status").notNull().default("active"),
    /** Row 91: "client" = a real project; "internal" = a time code (admin, training, PTO…) with no client or space. */
    kind: varchar("kind", { length: 16 }).notNull().default("client"),
    color: varchar("color", { length: 16 }).notNull().default("#6366f1"),
    startDate: timestamp("start_date", { withTimezone: true }),
    endDate: timestamp("end_date", { withTimezone: true }),
    /** Either budget can be unset; both are compared against logged time. */
    budgetHours: integer("budget_hours"),
    budgetAmount: doublePrecision("budget_amount"),
    hourlyRate: doublePrecision("hourly_rate"),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("projects_org_idx").on(t.organizationId),
    index("projects_company_idx").on(t.companyId),
    uniqueIndex("projects_space_uq").on(t.spaceId),
  ],
);

/**
 * One row per stretch of tracked time. A running timer is a row with no
 * `endedAt`; stopping it fills `endedAt` and `durationSeconds`. Manual and
 * timesheet entries are written complete. `source` records which, so the
 * timesheet grid can safely overwrite only what it created.
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** Row 87: optional project stage the hours belong to. */
    stageId: uuid("stage_id").references((): AnyPgColumn => projectStages.id, { onDelete: "set null" }),
    description: text("description"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    billable: boolean("billable").notNull().default(true),
    /** "timer" | "manual" | "timesheet" */
    source: varchar("source", { length: 16 }).notNull().default("timer"),
    ...timestamps,
  },
  (t) => [
    index("time_entries_user_started_idx").on(t.userId, t.startedAt),
    index("time_entries_project_started_idx").on(t.projectId, t.startedAt),
    index("time_entries_org_started_idx").on(t.organizationId, t.startedAt),
  ],
);

/** Planned hours: this person, this project, this week. Resourcing's cell. */
export const allocations = pgTable(
  "allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Monday 00:00 UTC of the week. Always normalised by the service. */
    weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
    hours: doublePrecision("hours").notNull(),
    note: text("note"),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("allocations_user_project_week_uq").on(t.userId, t.projectId, t.weekStart),
    index("allocations_org_week_idx").on(t.organizationId, t.weekStart),
  ],
);

/**
 * Row 39: who is on a project. The lead and creator are always implied; this
 * table holds everyone else. Assigning someone a task in the project adds them.
 * The project's chat channel is kept in sync with this team.
 */
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Row 85: lead | contributor | viewer - what this person may do on this project. */
    role: varchar("role", { length: 16 }).notNull().default("contributor"),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("project_members_pk").on(t.projectId, t.userId), index("project_members_user_idx").on(t.userId)],
);

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  space: one(spaces, { fields: [projects.spaceId], references: [spaces.id] }),
  members: many(projectMembers),
  channel: one(channels, { fields: [projects.id], references: [channels.projectId] }),
  company: one(companies, { fields: [projects.companyId], references: [companies.id] }),
  lead: one(users, { fields: [projects.leadId], references: [users.id] }),
  stages: many(projectStages),
  milestones: many(milestones),
  timeEntries: many(timeEntries),
  allocations: many(allocations),
}));

/* ------------------------------------------------------------------ *
 * Project stages — Discovery > Design > Build > QA > Launch. A project's
 * tasks can be filed under a stage; progress per stage is derived from
 * task status categories. Stages may run in parallel.
 * ------------------------------------------------------------------ */
export const stageStatus = pgEnum("stage_status", ["not_started", "active", "completed"]);

export const projectStages = pgTable(
  "project_stages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    position: doublePrecision("position").notNull().default(0),
    status: stageStatus("status").notNull().default("not_started"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Row 105: percent complete set by hand - never derived from tasks or hours. */
    progressPct: integer("progress_pct").notNull().default(0),
    progressSetById: uuid("progress_set_by_id").references(() => users.id, { onDelete: "set null" }),
    progressSetAt: timestamp("progress_set_at", { withTimezone: true }),
    progressNote: text("progress_note"),
    ...timestamps,
  },
  (t) => [index("project_stages_project_idx").on(t.projectId)],
);

export const projectStagesRelations = relations(projectStages, ({ one, many }) => ({
  project: one(projects, { fields: [projectStages.projectId], references: [projects.id] }),
  tasks: many(tasks),
  progressSetBy: one(users, { fields: [projectStages.progressSetById], references: [users.id] }),
  progressEvents: many(stageProgressEvents),
}));

/**
 * Row 112: one connected account per provider per workspace (Google Drive,
 * Dropbox). Tokens are encrypted at rest (integrations.service). Files are
 * only ever linked, never copied.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull(),
    /** connected | needs_reconnect | failing | disconnected */
    status: varchar("status", { length: 24 }).notNull().default("connected"),
    accountEmail: varchar("account_email", { length: 255 }),
    accountName: varchar("account_name", { length: 255 }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scopes: text("scopes"),
    connectedById: uuid("connected_by_id").references(() => users.id, { onDelete: "set null" }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("integrations_org_provider_uq").on(t.organizationId, t.provider)],
);

export const integrationsRelations = relations(integrations, ({ one }) => ({
  connectedBy: one(users, { fields: [integrations.connectedById], references: [users.id] }),
}));

/**
 * Row 16: comments on docs. A root comment usually anchors to highlighted text
 * (the editor keeps a mark carrying the comment id; `quote` is the text at the
 * time). Replies hang off `parentId`; resolving closes the whole thread.
 */
export const docComments = pgTable(
  "doc_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => docComments.id, { onDelete: "cascade" }),
    quote: text("quote"),
    body: text("body").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedById: uuid("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("doc_comments_doc_idx").on(t.documentId, t.createdAt)],
);

export const docCommentsRelations = relations(docComments, ({ one }) => ({
  author: one(users, { fields: [docComments.authorId], references: [users.id] }),
  resolvedBy: one(users, { fields: [docComments.resolvedById], references: [users.id], relationName: "doc_comment_resolver" }),
}));

/**
 * Row 124: a Drive / Dropbox (or any) file linked to a task, doc, project,
 * contact or company. The file stays where it lives; we keep the link plus
 * the metadata the provider told us last time we looked.
 */
export const linkedFiles = pgTable(
  "linked_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** task | document | project | contact | company */
    entityType: varchar("entity_type", { length: 16 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    /** google_drive | dropbox | link */
    provider: varchar("provider", { length: 24 }).notNull(),
    url: text("url").notNull(),
    externalId: varchar("external_id", { length: 255 }),
    name: varchar("name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 128 }),
    sizeBytes: integer("size_bytes"),
    iconUrl: text("icon_url"),
    lastModifiedAt: timestamp("last_modified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    addedById: uuid("added_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("linked_files_entity_idx").on(t.entityType, t.entityId)],
);

export const linkedFilesRelations = relations(linkedFiles, ({ one }) => ({
  addedBy: one(users, { fields: [linkedFiles.addedById], references: [users.id] }),
}));

/**
 * Row 120: a client guest's access link - one token per (person, set of
 * projects), with an expiry and one-click revoke. No account needed.
 */
export const portalAccess = pgTable(
  "portal_access",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 160 }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    projectIds: jsonb("project_ids").$type<string[]>().notNull().default([]),
    token: varchar("token", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    invitedById: uuid("invited_by_id").references(() => users.id, { onDelete: "set null" }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("portal_access_token_uq").on(t.token), index("portal_access_org_idx").on(t.organizationId)],
);

/** Row 122: what clients did on the portal - opened it, viewed a doc, approved something. */
export const portalEvents = pgTable(
  "portal_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accessId: uuid("access_id").references(() => portalAccess.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }),
    /** opened | viewed_doc | approved | changes_requested */
    kind: varchar("kind", { length: 24 }).notNull(),
    entityType: varchar("entity_type", { length: 24 }),
    entityId: uuid("entity_id"),
    label: varchar("label", { length: 255 }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("portal_events_project_idx").on(t.projectId, t.createdAt)],
);

export const portalAccessRelations = relations(portalAccess, ({ one }) => ({
  invitedBy: one(users, { fields: [portalAccess.invitedById], references: [users.id] }),
  contact: one(contacts, { fields: [portalAccess.contactId], references: [contacts.id] }),
}));

/**
 * Row 114: custom fields. A definition per (entity type, name); values stored
 * as JSON so one table serves text, number, date, select, checkbox, url, user.
 */
export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** task | project | contact */
    entityType: varchar("entity_type", { length: 16 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    /** text | number | date | select | checkbox | url | user */
    type: varchar("type", { length: 16 }).notNull(),
    /** For select: the allowed options. */
    options: jsonb("options").$type<string[]>(),
    position: doublePrecision("position").notNull().default(0),
    required: boolean("required").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("custom_field_defs_org_entity_idx").on(t.organizationId, t.entityType)],
);

export const customFieldValues = pgTable(
  "custom_field_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFieldDefs.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull(),
    value: jsonb("value"),
    updatedById: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("custom_field_entries_field_entity_uq").on(t.fieldId, t.entityId), index("custom_field_entries_entity_idx").on(t.entityId)],
);

export const customFieldDefsRelations = relations(customFieldDefs, ({ many }) => ({ values: many(customFieldValues) }));
export const customFieldValuesRelations = relations(customFieldValues, ({ one }) => ({
  field: one(customFieldDefs, { fields: [customFieldValues.fieldId], references: [customFieldDefs.id] }),
}));

/** Row 110: company holidays and closures. A day off on a working day lowers everyone's expected hours that week. */
export const holidays = pgTable(
  "holidays",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Midnight UTC of the day. */
    date: timestamp("date", { withTimezone: true }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    /** "holiday" (public) or "closure" (company decision). */
    kind: varchar("kind", { length: 16 }).notNull().default("holiday"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("holidays_org_date_uq").on(t.organizationId, t.date)],
);

/** Row 105: every hand-set progress change, with who, when and why (a note is required when it goes down). */
export const stageProgressEvents = pgTable(
  "stage_progress_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => projectStages.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    fromPct: integer("from_pct").notNull(),
    toPct: integer("to_pct").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("stage_progress_events_stage_idx").on(t.stageId, t.createdAt)],
);

export const stageProgressEventsRelations = relations(stageProgressEvents, ({ one }) => ({
  stage: one(projectStages, { fields: [stageProgressEvents.stageId], references: [projectStages.id] }),
  actor: one(users, { fields: [stageProgressEvents.actorId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ *
 * Milestones (row 32) — named checkpoints with a target date; "reached" is
 * set by hand so client-facing progress is a deliberate statement.
 * ------------------------------------------------------------------ */
export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    targetDate: timestamp("target_date", { withTimezone: true }),
    reachedAt: timestamp("reached_at", { withTimezone: true }),
    /** Row 75: sign-off request - null | pending | approved | rejected. Approving marks it reached. */
    signoffStatus: varchar("signoff_status", { length: 16 }),
    signoffRequestedById: uuid("signoff_requested_by_id").references(() => users.id, { onDelete: "set null" }),
    signoffRequestedAt: timestamp("signoff_requested_at", { withTimezone: true }),
    signoffApproverId: uuid("signoff_approver_id").references(() => users.id, { onDelete: "set null" }),
    signoffNote: text("signoff_note"),
    /** Shown on the client portal / share pages when true. */
    clientVisible: boolean("client_visible").notNull().default(false),
    /** Row 121: the client's one-click decision from the portal. */
    clientDecision: varchar("client_decision", { length: 24 }),
    clientDecidedAt: timestamp("client_decided_at", { withTimezone: true }),
    clientDecidedBy: varchar("client_decided_by", { length: 255 }),
    clientDecisionNote: text("client_decision_note"),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("milestones_project_idx").on(t.projectId)],
);

export const milestonesRelations = relations(milestones, ({ one, many }) => ({
  project: one(projects, { fields: [milestones.projectId], references: [projects.id] }),
  tasks: many(tasks),
}));

export type Milestone = typeof milestones.$inferSelect;

/* ------------------------------------------------------------------ *
 * Task list templates (row 33): a saved set of tasks, subtasks and
 * milestones; dates are day offsets from the project start.
 * ------------------------------------------------------------------ */
export interface TemplateTaskItem {
  title: string;
  description: string | null;
  priority: "urgent" | "high" | "normal" | "low" | null;
  timeEstimateMinutes: number | null;
  dueOffsetDays: number | null;
  stageName: string | null;
  milestoneName: string | null;
  tags: string[];
  subtasks: { title: string; dueOffsetDays: number | null }[];
}
export interface TemplateMilestoneItem {
  name: string;
  offsetDays: number | null;
  clientVisible: boolean;
}

export const taskTemplates = pgTable(
  "task_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    items: jsonb("items").$type<TemplateTaskItem[]>().notNull().default([]),
    milestones: jsonb("milestones").$type<TemplateMilestoneItem[]>().notNull().default([]),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("task_templates_org_idx").on(t.organizationId)],
);

export type TaskTemplate = typeof taskTemplates.$inferSelect;

/** Reusable stage sequences (Settings). One may be the default for new projects. */
export const stageTemplates = pgTable(
  "stage_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    /** Ordered stage names. */
    stages: jsonb("stages").$type<string[]>().notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("stage_templates_org_idx").on(t.organizationId)],
);

export type ProjectStage = typeof projectStages.$inferSelect;
export type StageTemplate = typeof stageTemplates.$inferSelect;

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  user: one(users, { fields: [timeEntries.userId], references: [users.id] }),
  project: one(projects, { fields: [timeEntries.projectId], references: [projects.id] }),
  task: one(tasks, { fields: [timeEntries.taskId], references: [tasks.id] }),
  stage: one(projectStages, { fields: [timeEntries.stageId], references: [projectStages.id] }),
}));

export const allocationsRelations = relations(allocations, ({ one }) => ({
  user: one(users, { fields: [allocations.userId], references: [users.id] }),
  project: one(projects, { fields: [allocations.projectId], references: [projects.id] }),
}));

export type Project = typeof projects.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type Allocation = typeof allocations.$inferSelect;

/* ================================================================== *
 * CRM: companies, contacts, deals, estimates, notes, meetings
 *
 * Companies and Contacts are the anchor — everything commercial points at
 * them. A Deal moves through a pipeline and, when won, can be converted into
 * a Project. Estimates are priced line items against a company, optionally
 * tied to a deal. Notes and Meetings attach to any of the three.
 * ================================================================== */

/** Row 53: stages are per-org rows now (renamable, reorderable); `kind` says which are terminal. */
export const dealStageKind = pgEnum("deal_stage_kind", ["open", "won", "lost"]);

export const dealStages = pgTable(
  "deal_stages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    kind: dealStageKind("kind").notNull().default("open"),
    /** Default probability a deal takes when it enters this stage. */
    probability: integer("probability").notNull().default(10),
    color: varchar("color", { length: 16 }).notNull().default("#6366f1"),
    position: doublePrecision("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("deal_stages_org_idx").on(t.organizationId)],
);

export const estimateStatus = pgEnum("estimate_status", [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
]);

export const crmNoteEntity = pgEnum("crm_note_entity", ["company", "contact", "deal"]);
/** Row 54: a note is one kind of interaction; calls, meetings and emails are logged the same way. */
export const crmNoteKind = pgEnum("crm_note_kind", ["note", "call", "meeting", "email"]);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    website: varchar("website", { length: 512 }),
    industry: varchar("industry", { length: 128 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 64 }),
    address: text("address"),
    /** The teammate who owns the relationship. */
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("companies_org_name_idx").on(t.organizationId, t.name)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    firstName: varchar("first_name", { length: 128 }).notNull(),
    lastName: varchar("last_name", { length: 128 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 64 }),
    /** Job title. */
    title: varchar("title", { length: 128 }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("contacts_company_idx").on(t.companyId),
    index("contacts_org_email_idx").on(t.organizationId, t.email),
  ],
);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** Set when a won deal is converted into delivery work. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    title: varchar("title", { length: 255 }).notNull(),
    value: doublePrecision("value").notNull().default(0),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    stageId: uuid("stage_id").references((): AnyPgColumn => dealStages.id, { onDelete: "set null" }),
    /** 0-100. Defaults per stage; editable. Drives weighted pipeline value. */
    probability: integer("probability").notNull().default(10),
    expectedCloseDate: timestamp("expected_close_date", { withTimezone: true }),
    /** Row 55: the next thing to do on this deal and when; the owner gets an inbox reminder when it's due. */
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    nextActionNote: varchar("next_action_note", { length: 255 }),
    /** Stamped when the reminder for the current nextActionAt has gone out. */
    nextActionRemindedAt: timestamp("next_action_reminded_at", { withTimezone: true }),
    /** Last human touch — edits, stage moves, logged interactions. Drives the stale flag. */
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lostReason: text("lost_reason"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** Kanban ordering within a stage column. */
    position: doublePrecision("position").notNull().default(0),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("deals_org_stage_idx").on(t.organizationId, t.stageId),
    index("deals_company_idx").on(t.companyId),
  ],
);

export const estimates = pgTable(
  "estimates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    /** Human key like EST-0007, sequential per org. */
    number: varchar("number", { length: 32 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    status: estimateStatus("status").notNull().default("draft"),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    issueDate: timestamp("issue_date", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /** Terms / message shown to the client. */
    notes: text("notes"),
    subtotal: doublePrecision("subtotal").notNull().default(0),
    taxRate: doublePrecision("tax_rate").notNull().default(0),
    taxAmount: doublePrecision("tax_amount").notNull().default(0),
    total: doublePrecision("total").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("estimates_org_number_uq").on(t.organizationId, t.number),
    index("estimates_company_idx").on(t.companyId),
  ],
);

export const estimateItems = pgTable(
  "estimate_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    estimateId: uuid("estimate_id")
      .notNull()
      .references(() => estimates.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: doublePrecision("quantity").notNull().default(1),
    unitPrice: doublePrecision("unit_price").notNull().default(0),
    amount: doublePrecision("amount").notNull().default(0),
    position: doublePrecision("position").notNull().default(0),
  },
  (t) => [index("estimate_items_estimate_idx").on(t.estimateId)],
);

/** Free-form notes pinned to a company, contact or deal. */
export const crmNotes = pgTable(
  "crm_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityType: crmNoteEntity("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    body: text("body").notNull(),
    kind: crmNoteKind("kind").notNull().default("note"),
    /** When the call/meeting happened (defaults to when it was logged). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    pinned: boolean("pinned").notNull().default(false),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [index("crm_notes_entity_idx").on(t.entityType, t.entityId)],
);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** A room, an address, or a call link. */
    location: varchar("location", { length: 512 }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    organizerId: uuid("organizer_id")
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [index("meetings_org_starts_idx").on(t.organizationId, t.startsAt)],
);

export const meetingAttendees = pgTable(
  "meeting_attendees",
  {
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("meeting_attendees_pk").on(t.meetingId, t.userId),
    index("meeting_attendees_user_idx").on(t.userId),
  ],
);

export const companiesRelations = relations(companies, ({ one, many }) => ({
  owner: one(users, { fields: [companies.ownerId], references: [users.id] }),
  contacts: many(contacts),
  deals: many(deals),
  tasks: many(tasks),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
  tasks: many(tasks),
}));

export const dealStagesRelations = relations(dealStages, ({ many }) => ({
  deals: many(deals),
}));

export const dealsRelations = relations(deals, ({ one, many }) => ({
  tasks: many(tasks),
  stage: one(dealStages, { fields: [deals.stageId], references: [dealStages.id] }),
  company: one(companies, { fields: [deals.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [deals.contactId], references: [contacts.id] }),
  project: one(projects, { fields: [deals.projectId], references: [projects.id] }),
  owner: one(users, { fields: [deals.ownerId], references: [users.id] }),
}));

/* ================================================================== *
 * PROPOSALS (rows 56-59): templated sections → numbered sent versions with
 * a PDF → per-contact links that track viewed / accepted / declined, with a
 * typed e-signature on accept.
 * ================================================================== */
export interface ProposalSection {
  key: string;
  title: string;
  body: string;
}

export const proposalStatus = pgEnum("proposal_status", ["draft", "sent", "viewed", "accepted", "declined"]);

export const proposalTemplates = pgTable(
  "proposal_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    sections: jsonb("sections").$type<ProposalSection[]>().notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("proposal_templates_org_idx").on(t.organizationId)],
);

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Human key like PRO-0007, sequential per org. */
    number: varchar("number", { length: 32 }).notNull(),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    templateId: uuid("template_id").references(() => proposalTemplates.id, { onDelete: "set null" }),
    title: varchar("title", { length: 255 }).notNull(),
    status: proposalStatus("status").notNull().default("draft"),
    /** The working copy; each send snapshots it into a version. */
    sections: jsonb("sections").$type<ProposalSection[]>().notNull().default([]),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    total: doublePrecision("total").notNull().default(0),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    currentVersion: integer("current_version").notNull().default(0),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("proposals_org_number_uq").on(t.organizationId, t.number),
    index("proposals_deal_idx").on(t.dealId),
    index("proposals_company_idx").on(t.companyId),
  ],
);

/** Row 57: what the client actually saw — frozen on every send. */
export const proposalVersions = pgTable(
  "proposal_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    sections: jsonb("sections").$type<ProposalSection[]>().notNull().default([]),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    total: doublePrecision("total").notNull().default(0),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /** Storage key of the rendered PDF. */
    pdfKey: text("pdf_key"),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    sentById: uuid("sent_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("proposal_versions_uq").on(t.proposalId, t.version)],
);

/** Rows 58-59: one unique link per contact per send; tracks viewed / accepted / declined and the typed signature. */
export const proposalRecipients = pgTable(
  "proposal_recipients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => proposalVersions.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }),
    token: varchar("token", { length: 64 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    signerName: varchar("signer_name", { length: 255 }),
    signerTitle: varchar("signer_title", { length: 255 }),
    signatureIp: varchar("signature_ip", { length: 64 }),
    signatureUserAgent: text("signature_user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("proposal_recipients_token_uq").on(t.token), index("proposal_recipients_proposal_idx").on(t.proposalId)],
);

export const proposalsRelations = relations(proposals, ({ one, many }) => ({
  deal: one(deals, { fields: [proposals.dealId], references: [deals.id] }),
  company: one(companies, { fields: [proposals.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [proposals.contactId], references: [contacts.id] }),
  template: one(proposalTemplates, { fields: [proposals.templateId], references: [proposalTemplates.id] }),
  createdBy: one(users, { fields: [proposals.createdById], references: [users.id] }),
  versions: many(proposalVersions),
  recipients: many(proposalRecipients),
}));

export const proposalVersionsRelations = relations(proposalVersions, ({ one, many }) => ({
  proposal: one(proposals, { fields: [proposalVersions.proposalId], references: [proposals.id] }),
  sentBy: one(users, { fields: [proposalVersions.sentById], references: [users.id] }),
  recipients: many(proposalRecipients),
}));

export const proposalRecipientsRelations = relations(proposalRecipients, ({ one }) => ({
  proposal: one(proposals, { fields: [proposalRecipients.proposalId], references: [proposals.id] }),
  version: one(proposalVersions, { fields: [proposalRecipients.versionId], references: [proposalVersions.id] }),
  contact: one(contacts, { fields: [proposalRecipients.contactId], references: [contacts.id] }),
}));

export const estimatesRelations = relations(estimates, ({ one, many }) => ({
  company: one(companies, { fields: [estimates.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [estimates.contactId], references: [contacts.id] }),
  deal: one(deals, { fields: [estimates.dealId], references: [deals.id] }),
  items: many(estimateItems),
}));

export const estimateItemsRelations = relations(estimateItems, ({ one }) => ({
  estimate: one(estimates, { fields: [estimateItems.estimateId], references: [estimates.id] }),
}));

export const crmNotesRelations = relations(crmNotes, ({ one }) => ({
  author: one(users, { fields: [crmNotes.authorId], references: [users.id] }),
}));

export const meetingsRelations = relations(meetings, ({ one, many }) => ({
  company: one(companies, { fields: [meetings.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [meetings.contactId], references: [contacts.id] }),
  deal: one(deals, { fields: [meetings.dealId], references: [deals.id] }),
  organizer: one(users, { fields: [meetings.organizerId], references: [users.id] }),
  attendees: many(meetingAttendees),
}));

export const meetingAttendeesRelations = relations(meetingAttendees, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingAttendees.meetingId], references: [meetings.id] }),
  user: one(users, { fields: [meetingAttendees.userId], references: [users.id] }),
}));

export type Company = typeof companies.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type Estimate = typeof estimates.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;

/* ------------------------------------------------------------------ *
 * Documents — internal rich-text pages, optionally attached to a project.
 * (The "Docs" nav item.) Plain text/markdown body; no external editor deps.
 * ------------------------------------------------------------------ */
/** Row 62: who can open a doc. "default" follows the project team (or everyone when unfiled); "restricted" = named people/roles only. */
export const docAccess = pgEnum("doc_access", ["default", "restricted"]);
/** Row 63: Draft → In review → Approved; editing an approved doc drops it back to Draft. */
export const docReviewStatus = pgEnum("doc_review_status", ["draft", "in_review", "approved"]);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** Nested pages: a doc may live under another doc. Deleting a parent orphans children to top level. */
    parentId: uuid("parent_id").references((): AnyPgColumn => documents.id, { onDelete: "set null" }),
    title: varchar("title", { length: 255 }).notNull(),
    /** Plain-text rendering of `content` — used for excerpts and search. */
    body: text("body").notNull().default(""),
    /** Rich content as TipTap/ProseMirror JSON. Null for legacy plain-text docs (see `body`). */
    content: jsonb("content").$type<Record<string, unknown>>(),
    icon: varchar("icon", { length: 16 }),
    /** Cover as a CSS colour/gradient key; image covers need file storage (later). */
    cover: varchar("cover", { length: 64 }),
    /** Per-doc presentation: font family, font size, page width. */
    settings: jsonb("settings").$type<DocumentSettings>().notNull().default({}),
    /** Row 62 */
    access: docAccess("access").notNull().default("default"),
    /** Row 70: this doc was replaced by a newer one from `effectiveFrom`; it stays readable. */
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => documents.id, { onDelete: "set null" }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    /** Row 119: listed on the client portal (internal blocks stripped) when true. */
    clientVisible: boolean("client_visible").notNull().default(false),
    /** Row 121 */
    clientDecision: varchar("client_decision", { length: 24 }),
    clientDecidedAt: timestamp("client_decided_at", { withTimezone: true }),
    clientDecidedBy: varchar("client_decided_by", { length: 255 }),
    clientDecisionNote: text("client_decision_note"),
    /** Row 65: public read-only link (internal-only blocks stripped). Null = not shared. */
    shareToken: varchar("share_token", { length: 64 }),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    /** Row 63: sign-off. */
    reviewStatus: docReviewStatus("review_status").notNull().default("draft"),
    approverId: uuid("approver_id").references(() => users.id, { onDelete: "set null" }),
    reviewRequestedById: uuid("review_requested_by_id").references(() => users.id, { onDelete: "set null" }),
    reviewRequestedAt: timestamp("review_requested_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdById: uuid("created_by_id").references(() => users.id),
    updatedById: uuid("updated_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("documents_org_idx").on(t.organizationId),
    index("documents_project_idx").on(t.projectId),
    index("documents_parent_idx").on(t.parentId),
  ],
);

export interface DocumentSettings {
  font?: "sans" | "serif" | "mono";
  fontSize?: "sm" | "md" | "lg";
  width?: "narrow" | "wide";
}

export const documentAccess = pgTable(
  "document_access",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    /** Exactly one of these is set. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("document_access_doc_idx").on(t.documentId)],
);

export const documentAccessRelations = relations(documentAccess, ({ one }) => ({
  document: one(documents, { fields: [documentAccess.documentId], references: [documents.id] }),
  user: one(users, { fields: [documentAccess.userId], references: [users.id] }),
}));

/** Row 69: per-person starred docs and last-opened times, across every project. */
export const documentStars = pgTable(
  "document_stars",
  {
    documentId: uuid("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("document_stars_pk").on(t.documentId, t.userId), index("document_stars_user_idx").on(t.userId)],
);

export const documentVisits = pgTable(
  "document_visits",
  {
    documentId: uuid("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("document_visits_pk").on(t.documentId, t.userId), index("document_visits_user_idx").on(t.userId, t.lastOpenedAt)],
);

/** Row 68: the docs every new project starts with (brief, kickoff notes, SOW, QA checklist…). */
export const docTemplates = pgTable(
  "doc_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    icon: varchar("icon", { length: 16 }),
    content: jsonb("content").$type<Record<string, unknown>>(),
    body: text("body").notNull().default(""),
    position: doublePrecision("position").notNull().default(0),
    /** Created automatically for every new project. Off = available on demand only. */
    inKit: boolean("in_kit").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("doc_templates_org_idx").on(t.organizationId)],
);

/**
 * Row 66: reusable content. A doc embeds a snippet by id, so editing the
 * snippet updates every doc that uses it.
 */
export const snippets = pgTable(
  "snippets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    /** TipTap JSON (a `doc` node whose content is the snippet's blocks). */
    content: jsonb("content").$type<Record<string, unknown>>(),
    body: text("body").notNull().default(""),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    updatedById: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("snippets_org_idx").on(t.organizationId)],
);

/** Row 61: a doc attached to a project, task, client or deal so it shows on that record's Docs tab. */
export const docLinkEntity = pgEnum("doc_link_entity", ["project", "task", "company", "deal"]);

export const documentLinks = pgTable(
  "document_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    entityType: docLinkEntity("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("document_links_uq").on(t.documentId, t.entityType, t.entityId), index("document_links_entity_idx").on(t.entityType, t.entityId)],
);

export const documentLinksRelations = relations(documentLinks, ({ one }) => ({
  document: one(documents, { fields: [documentLinks.documentId], references: [documents.id] }),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  organization: one(organizations, { fields: [documents.organizationId], references: [organizations.id] }),
  links: many(documentLinks),
  accessList: many(documentAccess),
  approver: one(users, { fields: [documents.approverId], references: [users.id], relationName: "document_approver" }),
  supersededBy: one(documents, { fields: [documents.supersededById], references: [documents.id], relationName: "document_supersedes" }),
  supersedes: many(documents, { relationName: "document_supersedes" }),
  reviewRequestedBy: one(users, { fields: [documents.reviewRequestedById], references: [users.id], relationName: "document_review_requester" }),
  project: one(projects, { fields: [documents.projectId], references: [projects.id] }),
  parent: one(documents, {
    fields: [documents.parentId],
    references: [documents.id],
    relationName: "document_children",
  }),
  children: many(documents, { relationName: "document_children" }),
  createdBy: one(users, {
    fields: [documents.createdById],
    references: [users.id],
    relationName: "document_creator",
  }),
  updatedBy: one(users, {
    fields: [documents.updatedById],
    references: [users.id],
    relationName: "document_editor",
  }),
}));

export type Document = typeof documents.$inferSelect;

/* ------------------------------------------------------------------ *
 * Bookmarks — saved links on a Space's overview page.
 * ------------------------------------------------------------------ */
export const bookmarks = pgTable(
  "bookmarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    url: text("url").notNull(),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("bookmarks_space_idx").on(t.spaceId)],
);

export type Bookmark = typeof bookmarks.$inferSelect;

/* ------------------------------------------------------------------ *
 * Reminders (row 72) - one row per (receiver, thing, kind, due date) so a
 * "due tomorrow" / "overdue" nudge goes out exactly once. Move the due date
 * and a fresh reminder is allowed; it never repeats daily for the same date.
 * ------------------------------------------------------------------ */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    receiverId: uuid("receiver_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "task" | "milestone" | "timesheet" ... */
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    /** "due_soon" | "overdue" | ... */
    kind: varchar("kind", { length: 24 }).notNull(),
    /** The due date this reminder was about; a changed date is a new event. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("reminders_once_uq").on(t.receiverId, t.entityType, t.entityId, t.kind, t.dueAt),
    index("reminders_entity_idx").on(t.entityType, t.entityId),
  ],
);

export type Reminder = typeof reminders.$inferSelect;

/* ------------------------------------------------------------------ *
 * Mutes (row 74) - "stop telling me about this thread". Muting a task, doc
 * or project silences every notification about it (a project mute covers
 * its tasks, docs and milestones). Unlike unfollowing, it also blocks
 * @mentions - it's the user's explicit "I know, leave me alone".
 * ------------------------------------------------------------------ */
export const notificationMutes = pgTable(
  "notification_mutes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "task" | "document" | "project" */
    entityType: varchar("entity_type", { length: 16 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("notification_mutes_uq").on(t.userId, t.entityType, t.entityId)],
);

export type NotificationMute = typeof notificationMutes.$inferSelect;

/* ------------------------------------------------------------------ *
 * Timesheet submissions (row 75) - a person submits a week; an approver
 * signs it off from the inbox. Row 92 builds on this (locking approved hours).
 * ------------------------------------------------------------------ */
export const timesheetSubmissions = pgTable(
  "timesheet_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Monday 00:00 UTC (see time.service startOfWeek). */
    weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
    /** submitted | approved | rejected */
    status: varchar("status", { length: 16 }).notNull().default("submitted"),
    approverId: uuid("approver_id").references(() => users.id, { onDelete: "set null" }),
    totalSeconds: integer("total_seconds").notNull().default(0),
    note: text("note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedById: uuid("decided_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("timesheet_submissions_user_week_uq").on(t.userId, t.weekStart)],
);

export type TimesheetSubmission = typeof timesheetSubmissions.$inferSelect;

/* ------------------------------------------------------------------ *
 * Follows (row 77) - "tell me what happens here" for a task, doc or
 * project. Supersedes task_subscribers (kept for the data copy; the app
 * reads and writes this table only). Assignment and @mentions auto-follow.
 * ------------------------------------------------------------------ */
export const follows = pgTable(
  "follows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "task" | "document" | "project" */
    entityType: varchar("entity_type", { length: 16 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    /** "manual" | "assigned" | "mentioned" | "created" - why the follow exists. */
    reason: varchar("reason", { length: 16 }).notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("follows_uq").on(t.userId, t.entityType, t.entityId),
    index("follows_entity_idx").on(t.entityType, t.entityId),
  ],
);

export type Follow = typeof follows.$inferSelect;

/* ------------------------------------------------------------------ *
 * Sign-in attempts (row 79) - brute-force lockout. One row per e-mail;
 * five wrong passwords lock the address for fifteen minutes. Sign-in goes
 * through our API (which proxies to Supabase) so the lock is enforceable.
 * ------------------------------------------------------------------ */
export const signInAttempts = pgTable("sign_in_attempts", {
  email: varchar("email", { length: 320 }).primaryKey(),
  failedCount: integer("failed_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
});

/* ------------------------------------------------------------------ *
 * 2FA backup codes (row 81). TOTP itself lives in Supabase Auth; backup
 * codes are ours: ten single-use codes, stored hashed. Using one marks the
 * current Supabase session (its `session_id` claim) as second-factor
 * verified for twelve hours.
 * ------------------------------------------------------------------ */
export const mfaBackupCodes = pgTable(
  "mfa_backup_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("mfa_backup_codes_user_idx").on(t.userId)],
);

export const mfaBackupSessions = pgTable("mfa_backup_sessions", {
  sessionId: varchar("session_id", { length: 64 }).primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/* ------------------------------------------------------------------ *
 * Invitations (row 83) - one row per invite e-mail. The placeholder user +
 * membership are created at invite time (so assignments can already point
 * at the person); this row carries the token in the e-mailed link, who sent
 * it, when it was last (re)sent, and whether it was accepted or revoked.
 * ------------------------------------------------------------------ */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: membershipRole("role").notNull().default("member"),
    token: varchar("token", { length: 64 }).notNull(),
    invitedById: uuid("invited_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).defaultNow().notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("invitations_token_uq").on(t.token), index("invitations_org_idx").on(t.organizationId)],
);

export type Invitation = typeof invitations.$inferSelect;

export const invitationsRelations = relations(invitations, ({ one }) => ({
  organization: one(organizations, { fields: [invitations.organizationId], references: [organizations.id] }),
  user: one(users, { fields: [invitations.userId], references: [users.id], relationName: "invitation_user" }),
  invitedBy: one(users, { fields: [invitations.invitedById], references: [users.id], relationName: "invitation_inviter" }),
}));

export const timesheetSubmissionsRelations = relations(timesheetSubmissions, ({ one }) => ({
  user: one(users, { fields: [timesheetSubmissions.userId], references: [users.id], relationName: "timesheet_owner" }),
  approver: one(users, { fields: [timesheetSubmissions.approverId], references: [users.id], relationName: "timesheet_approver" }),
  decidedBy: one(users, { fields: [timesheetSubmissions.decidedById], references: [users.id], relationName: "timesheet_decider" }),
}));

/* ------------------------------------------------------------------ *
 * Timesheet trail (row 93) - every submit / approve / reject / unlock /
 * resubmit on a week, with who and why. Never edited, never deleted.
 * ------------------------------------------------------------------ */
export const timesheetEvents = pgTable(
  "timesheet_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => timesheetSubmissions.id, { onDelete: "cascade" }),
    /** submitted | resubmitted | approved | rejected | reopened */
    kind: varchar("kind", { length: 16 }).notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("timesheet_events_submission_idx").on(t.submissionId)],
);

export const timesheetEventsRelations = relations(timesheetEvents, ({ one }) => ({
  actor: one(users, { fields: [timesheetEvents.actorId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ *
 * Leave / PTO requests (row 98). Approved leave is written into the
 * timesheet as hours on the "PTO" internal code, one entry per weekday,
 * so capacity maths and the team calendar see it without special cases.
 * ------------------------------------------------------------------ */
export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** vacation | sick | personal | other */
    kind: varchar("kind", { length: 16 }).notNull().default("vacation"),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    /** Hours per weekday of leave; defaults to capacity / 5. */
    hoursPerDay: doublePrecision("hours_per_day").notNull().default(8),
    note: text("note"),
    /** pending | approved | rejected | cancelled */
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    approverId: uuid("approver_id").references(() => users.id, { onDelete: "set null" }),
    decidedById: uuid("decided_by_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("leave_requests_org_user_idx").on(t.organizationId, t.userId), index("leave_requests_dates_idx").on(t.startDate, t.endDate)],
);

export const leaveRequestsRelations = relations(leaveRequests, ({ one }) => ({
  user: one(users, { fields: [leaveRequests.userId], references: [users.id], relationName: "leave_user" }),
  decidedBy: one(users, { fields: [leaveRequests.decidedById], references: [users.id], relationName: "leave_decider" }),
}));
