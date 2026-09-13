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

export const customFieldType = pgEnum("custom_field_type", [
  "text",
  "number",
  "date",
  "checkbox",
  "url",
  "select",
  "multi_select",
  "user",
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
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
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
  (t) => [index("attachments_task_idx").on(t.taskId)],
);

/* ------------------------------------------------------------------ *
 * Custom fields (schema + values)
 * ------------------------------------------------------------------ */

export const customFields = pgTable(
  "custom_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 128 }).notNull(),
    type: customFieldType("type").notNull(),
    /** For select/multi_select: the option list. Shape: [{id,label,color}]. */
    config: jsonb("config").$type<Record<string, unknown>>(),
    position: doublePrecision("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("custom_fields_space_idx").on(t.spaceId)],
);

/** One row per (task, field). `value` is jsonb so a single table holds every
 *  field type — text, number, date, option ids, user ids. */
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFields.id, { onDelete: "cascade" }),
    value: jsonb("value"),
    ...timestamps,
  },
  (t) => [uniqueIndex("custom_field_values_task_field_uq").on(t.taskId, t.fieldId)],
);

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
  parent: one(tasks, { fields: [tasks.parentTaskId], references: [tasks.id], relationName: "subtasks" }),
  subtasks: many(tasks, { relationName: "subtasks" }),
  assignees: many(taskAssignees),
  taskTags: many(taskTags),
  comments: many(comments),
  attachments: many(attachments),
  customFieldValues: many(customFieldValues),
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
export type CustomField = typeof customFields.$inferSelect;

/* ================================================================== *
 * CHAT  (channels + direct messages, real-time via WS gateway)
 * ================================================================== */
export const channelType = pgEnum("channel_type", ["channel", "dm"]);

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
    /** Threaded replies (optional). */
    parentMessageId: uuid("parent_message_id"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("messages_channel_created_idx").on(t.channelId, t.createdAt)],
);

export const channelsRelations = relations(channels, ({ many, one }) => ({
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
    description: text("description"),
    status: projectStatus("status").notNull().default("active"),
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
    ...timestamps,
  },
  (t) => [index("project_stages_project_idx").on(t.projectId)],
);

export const projectStagesRelations = relations(projectStages, ({ one, many }) => ({
  project: one(projects, { fields: [projectStages.projectId], references: [projects.id] }),
  tasks: many(tasks),
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
    /** Shown on the client portal / share pages when true. */
    clientVisible: boolean("client_visible").notNull().default(false),
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

export const dealStage = pgEnum("deal_stage", [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
]);

export const estimateStatus = pgEnum("estimate_status", [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
]);

export const crmNoteEntity = pgEnum("crm_note_entity", ["company", "contact", "deal"]);

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
    stage: dealStage("stage").notNull().default("lead"),
    /** 0-100. Defaults per stage; editable. Drives weighted pipeline value. */
    probability: integer("probability").notNull().default(10),
    expectedCloseDate: timestamp("expected_close_date", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lostReason: text("lost_reason"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** Kanban ordering within a stage column. */
    position: doublePrecision("position").notNull().default(0),
    createdById: uuid("created_by_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("deals_org_stage_idx").on(t.organizationId, t.stage),
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

export const dealsRelations = relations(deals, ({ one, many }) => ({
  tasks: many(tasks),
  company: one(companies, { fields: [deals.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [deals.contactId], references: [contacts.id] }),
  project: one(projects, { fields: [deals.projectId], references: [projects.id] }),
  owner: one(users, { fields: [deals.ownerId], references: [users.id] }),
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

export const documentsRelations = relations(documents, ({ one, many }) => ({
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
