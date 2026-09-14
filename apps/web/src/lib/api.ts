/**
 * Typed fetch client. Every request carries the caller's Supabase access token
 * plus the org they're acting in; the API verifies both (signature + membership)
 * before a handler runs. supabase-js refreshes the token in the background, so
 * we just read the current one per request — and retry once on a 401 in case we
 * raced a rotation.
 */
import { supabase } from "./supabase.js";

export const API_URL: string =
  import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:3333" : "");

/** False on a deployed build until VITE_API_URL is set — the shell shows a banner. */
export const API_CONFIGURED = Boolean(API_URL);

const ORG_STORAGE_KEY = "pm:activeOrgId";

let activeOrgId: string | null = localStorage.getItem(ORG_STORAGE_KEY);

/** Set by AuthProvider once we know which org the user is acting in. */
export function setActiveOrg(orgId: string | null) {
  activeOrgId = orgId;
  if (orgId) localStorage.setItem(ORG_STORAGE_KEY, orgId);
  else localStorage.removeItem(ORG_STORAGE_KEY);
}

export function getActiveOrg() {
  return activeOrgId;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function accessToken(forceRefresh = false) {
  if (forceRefresh) {
    const { data } = await supabase.auth.refreshSession();
    return data.session?.access_token ?? null;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function request<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  if (!API_CONFIGURED) throw new ApiError(0, "API not connected");
  const token = await accessToken();
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeOrgId ? { "x-org-id": activeOrgId } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401 && retry) {
    // Token may have just expired or been rotated — refresh once, then retry.
    const fresh = await accessToken(true);
    if (fresh) return request<T>(path, init, false);
  }

  if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Unauthenticated calls for client-facing pages (proposal links). The token in the URL is the credential. */
async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_CONFIGURED) throw new ApiError(0, "API not connected");
  const res = await fetch(`${API_URL}/api${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Multipart POST (file uploads): no JSON content-type so the browser sets the boundary. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  if (!API_CONFIGURED) throw new ApiError(0, "API not connected");
  const token = await accessToken();
  const res = await fetch(`${API_URL}/api${path}`, {
    method: "POST",
    body: form,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeOrgId ? { "x-org-id": activeOrgId } : {}),
    },
  });
  if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** A shared file (row 43): in chat, or attached to a task. */
export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  taskId: string | null;
  channelId: string | null;
  messageId: string | null;
  createdAt: string;
  uploadedBy: { id: string; name: string } | null;
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
}

/** Row 83 */
export interface Invitation {
  id: string;
  email: string;
  role: string;
  userId: string;
  invitedBy: { id: string; name: string } | null;
  createdAt: string;
  lastSentAt: string;
  emailConfigured: boolean;
}

export interface MfaState {
  enrolled: boolean;
  verified: boolean;
}

export interface Membership {
  organizationId: string;
  role: "owner" | "admin" | "member" | "guest";
  /** Row 81 */
  mfaRequired?: boolean;
  /** Row 86 */
  accessEnded?: boolean;
  endDate?: string | null;
  organization: { id: string; name: string; slug: string };
}

export type Priority = "urgent" | "high" | "normal" | "low";

export interface Member {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  /** Row 86 */
  deactivatedAt?: string | null;
  endDate?: string | null;
  accessEnded?: boolean;
  /** Invited by email and has not signed in yet. */
  pending?: boolean;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  /** Only present from getTags({ usage: true }). */
  taskCount?: number;
}

export interface SpaceOverview {
  space: { id: string; name: string; color: string | null };
  project: { id: string; name: string } | null;
  folders: { id: string; name: string; lists: OverviewList[] }[];
  lists: OverviewList[];
  workload: { statusId: string | null; name: string; color: string; count: number }[];
  docs: { id: string; title: string; updatedAt: string }[];
  bookmarks: { id: string; title: string; url: string }[];
}

export interface OverviewList {
  id: string;
  name: string;
  folderId: string | null;
  tasksTotal: number;
  tasksDone: number;
}

export interface DocSettings {
  font?: "sans" | "serif" | "mono";
  fontSize?: "sm" | "md" | "lg";
  width?: "narrow" | "wide";
}

/** Row 68: a doc template in the project starter kit. */
export interface DocTemplate {
  id: string;
  title: string;
  icon: string | null;
  content: Record<string, unknown> | null;
  body: string;
  position: number;
  inKit: boolean;
}

/** Row 66: reusable content, embedded by reference. */
export interface Snippet {
  id: string;
  name: string;
  content: Record<string, unknown> | null;
  body: string;
  updatedAt: string;
}

export type DocAccess = "default" | "restricted";
export type DocReviewStatus = "draft" | "in_review" | "approved";

export interface DocSummary {
  id: string;
  title: string;
  icon: string | null;
  cover: string | null;
  parentId: string | null;
  /** Row 62 */
  access?: DocAccess;
  /** Row 69 */
  starred?: boolean;
  lastOpenedAt?: string;
  /** Row 70 */
  supersededById?: string | null;
  /** Row 63 */
  reviewStatus?: DocReviewStatus;
  approver?: { id: string; name: string } | null;
  excerpt: string;
  project: { id: string; name: string } | null;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
}

export interface DocRef {
  id: string;
  title: string;
  icon: string | null;
}

export type DocLinkEntity = "project" | "task" | "company" | "deal";
export interface DocLink {
  id: string;
  entityType: DocLinkEntity;
  entityId: string;
  label: string;
}

export interface Doc {
  id: string;
  title: string;
  /** Row 61: records this doc is attached to. */
  links: DocLink[];
  /** Row 62: who may open it. */
  access: DocAccess;
  accessUsers: { id: string; name: string }[];
  accessRoles: string[];
  /** Row 69 */
  starred: boolean;
  /** Row 70: replaced by a newer doc from `effectiveFrom`; `supersedes` lists what this one replaced. */
  supersededById: string | null;
  supersededAt: string | null;
  effectiveFrom: string | null;
  supersededBy: DocRef | null;
  supersedes: (DocRef & { effectiveFrom: string | null })[];
  /** Row 65: share link token (null = not shared). */
  shareToken: string | null;
  sharedAt: string | null;
  /** Row 63: sign-off. */
  reviewStatus: DocReviewStatus;
  approverId: string | null;
  approver: { id: string; name: string } | null;
  reviewRequestedBy: { id: string; name: string } | null;
  reviewRequestedAt: string | null;
  approvedAt: string | null;
  reviewNote: string | null;
  /** Plain text mirror of `content`; the only content for docs written before the block editor. */
  body: string;
  /** TipTap JSON, null for legacy plain-text docs. */
  content: Record<string, unknown> | null;
  icon: string | null;
  cover: string | null;
  settings: DocSettings;
  projectId: string | null;
  parentId: string | null;
  parent: DocRef | null;
  children: (DocRef & { updatedAt: string })[];
  project: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  updatedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocWrite {
  title?: string;
  body?: string;
  content?: Record<string, unknown> | null;
  projectId?: string | null;
  parentId?: string | null;
  icon?: string | null;
  cover?: string | null;
  settings?: DocSettings;
}

export interface Status {
  id: string;
  name: string;
  color: string;
  category: "not_started" | "active" | "done" | "closed";
  position: number;
}

export interface SpaceTree {
  id: string;
  name: string;
  color: string | null;
  lists: { id: string; name: string }[];
  folders: { id: string; name: string; lists: { id: string; name: string }[] }[];
}

export interface Task {
  id: string;
  title: string;
  /** Row 95: time logged against the task, for estimate-vs-actual. */
  loggedSeconds?: number;
  description: string | null;
  reference: string | null;
  priority: Priority | null;
  startDate: string | null;
  dueDate: string | null;
  /** Whole minutes. */
  timeEstimateMinutes: number | null;
  statusId: string | null;
  status: Status | null;
  assignees: { user: Member }[];
  stageId?: string | null;
  stage?: { id: string; name: string; status: StageStatus } | null;
  milestoneId?: string | null;
  milestone?: { id: string; name: string; targetDate: string | null; reachedAt: string | null } | null;
  recurrence?: Recurrence | null;
  recurrenceInterval?: number;
  recurredFromId?: string | null;
  /** CRM links (row 38). */
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  company?: { id: string; name: string } | null;
  contact?: { id: string; firstName: string; lastName: string | null } | null;
  deal?: { id: string; title: string; stage: { name: string; kind: DealStageKind } | null } | null;
  /** Row 47: where this task came from, when it was made from chat. */
  sourceMessage?: { id: string; channelId: string; body: string; createdAt: string; author: { id: string; name: string } | null; channel: { id: string; name: string | null; type: "channel" | "dm" } | null } | null;
  parentTaskId?: string | null;
  subtasks: {
    id: string;
    title?: string;
    status?: Status | null;
    statusId?: string | null;
    priority?: Priority | null;
    dueDate?: string | null;
    assignees?: { user: Member }[];
  }[];
  tags?: Tag[];
  cycleId?: string | null;
  listId?: string;
  comments?: { id: string; body: string; createdAt: string; author: Member }[];
}


export interface ActivityEntry {
  id: string;
  action: string;
  changes: { field: string; from: unknown; to: unknown }[];
  createdAt: string;
  actor: { id: string; name: string; avatarUrl: string | null } | null;
}

/** Row 67 + 108: workspace brand. */
export interface Branding {
  name: string;
  brandColor: string;
  brandLogoUrl: string | null;
  brandFooter: string | null;
  brandFaviconUrl: string | null;
}

/** Row 104: a submitted week waiting on me. */
export interface PendingTimesheet {
  id: string;
  userId: string;
  user: { id: string; name: string; avatarUrl: string | null };
  weekStart: string;
  totalSeconds: number;
  expectedHours: number;
  note: string | null;
  submittedAt: string;
  approverId: string | null;
}

/** Row 103: hours this week per person. */
export interface WorkloadPerson {
  userId: string;
  name: string;
  avatarUrl: string | null;
  expected: number;
  projectHours: number;
  internalHours: number;
  leaveHours: number;
  totalHours: number;
  projects: { id: string; name: string; color: string | null; seconds: number; hours: number }[];
}
export interface TeamWorkload {
  weekStart: string;
  people: WorkloadPerson[];
}

/** Row 102: one project's feed, with the entity each row is about. */
export interface ProjectActivityEntry extends ActivityEntry {
  entityType: string;
  entityId: string;
  entity: { type: string; id: string; label: string | null };
}
export interface ProjectActivity {
  entries: ProjectActivityEntry[];
  statuses: Record<string, string>;
  users: Record<string, string>;
}

/** Row 71: inbox tabs by type (plus the Replies section and the two parked tabs). */
export type InboxTab = "all" | "mentions" | "assigned" | "approvals" | "alerts" | "replies" | "later" | "cleared";
export type TypedInboxTab = "all" | "mentions" | "assigned" | "approvals" | "alerts";

export interface AppNotification {
  id: string;
  entityType: string;
  entityId: string;
  verb: string;
  category: "primary" | "other";
  isImportant: boolean;
  title: string;
  body: string | null;
  readAt: string | null;
  snoozedTill: string | null;
  archivedAt: string | null;
  createdAt: string;
  triggeredBy: { id: string; name: string; avatarUrl: string | null } | null;
  /** How much conversation is on the task - the bubble in the inbox row. */
  replyCount: number;
  /** Extras for non-task entities, e.g. { channelId } on a chat mention (row 41). */
  data?: Record<string, unknown> | null;
}

export interface UnreadCounts {
  count: number;
  all: number;
  mentions: number;
  assigned: number;
  approvals: number;
  alerts: number;
  replies: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  body: string;
  parentCommentId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  author: { id: string; name: string; avatarUrl: string | null };
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  task?: { id: string; title: string; reference: string | null; status: Status | null } | null;
}

/** Fields PATCH /tasks/:id accepts. `null` clears a value. */
export type Recurrence = "daily" | "weekly" | "monthly";

export type TaskPatch = Partial<{
  recurrence: Recurrence | null;
  recurrenceInterval: number;
  companyId: string | null;
  contactId: string | null;
  dealId: string | null;
  title: string;
  description: string;
  statusId: string;
  priority: Priority | null;
  startDate: string | null;
  dueDate: string | null;
  timeEstimateMinutes: number | null;
  stageId: string | null;
  milestoneId: string | null;
  assigneeIds: string[];
}>;

export interface TaskTemplate {
  id: string;
  name: string;
  description: string | null;
  taskCount: number;
  subtaskCount: number;
  milestoneCount: number;
  createdAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  reachedAt: string | null;
  clientVisible: boolean;
  /** Row 75 */
  signoffStatus: "pending" | "approved" | "rejected" | null;
  signoffRequestedById: string | null;
  signoffApproverId: string | null;
  signoffNote: string | null;
  progress: { total: number; done: number };
  /** Row 106: inside the risk window with open linked tasks. */
  atRisk?: boolean;
}
export interface AtRiskMilestone {
  id: string;
  name: string;
  targetDate: string;
  daysLeft: number;
  openTasks: number;
  totalTasks: number;
  project: { id: string; name: string; color: string | null };
  leadId: string | null;
  createdById: string | null;
}
export type MilestoneWrite = Partial<{
  name: string;
  description: string | null;
  targetDate: string | null;
  reachedAt: string | null;
  clientVisible: boolean;
}>;

export type BulkTaskPatch = Partial<{
  statusId: string;
  priority: Priority | null;
  dueDate: string | null;
  startDate: string | null;
  assigneeIds: string[];
  stageId: string | null;
  milestoneId: string | null;
  addTagIds: string[];
  removeTagIds: string[];
  listId: string;
}>;

export type StageStatus = "not_started" | "active" | "completed";
export interface Stage {
  id: string;
  projectId: string;
  name: string;
  position: number;
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  /** Tasks done in this stage - shown for context only. */
  progress: { total: number; done: number };
  /** Row 105: percent complete set by hand. */
  progressPct: number;
  progressSetAt: string | null;
  progressSetBy: { id: string; name: string } | null;
  progressNote: string | null;
}
export interface StageProgressEvent {
  id: string;
  fromPct: number;
  toPct: number;
  note: string | null;
  createdAt: string;
  actor: { id: string; name: string; avatarUrl: string | null } | null;
}
export interface StageTemplate {
  id: string;
  name: string;
  stages: string[];
  isDefault: boolean;
}

export interface MyTask extends Task {
  list: { id: string; name: string; spaceId: string; spaceName: string | null } | null;
}

/** Row 75: approval request carried by a notification (`data.approval`). */
export interface ApprovalMeta {
  kind: "doc_review" | "milestone" | "timesheet" | "leave";
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
  decidedById?: string;
  note?: string | null;
}

/** Row 74: a muted thread. */
export type MutableEntity = "task" | "document" | "project";
export interface NotificationMute {
  id: string;
  entityType: MutableEntity;
  entityId: string;
  name: string;
  createdAt: string;
}

/** Row 73: per-type delivery switches. */
export type NotifType =
  | "mention"
  | "assigned"
  | "comment"
  | "statusChange"
  | "propertyChange"
  | "taskCompleted"
  | "approvals"
  | "reminders"
  | "chat"
  | "following";
export interface ChannelPrefs {
  inApp: boolean;
  email: boolean;
  push: boolean;
}
/** Row 76 */
export interface DigestPrefs {
  frequency: "off" | "daily" | "weekly";
  hour: number;
  weekday: number;
  inApp: boolean;
  email: boolean;
}
export interface DigestItem {
  id: string;
  title: string;
  meta?: string | null;
  link?: string;
}
export interface DigestSections {
  period: "daily" | "weekly";
  since: string;
  dueToday: DigestItem[];
  overdue: DigestItem[];
  assignments: DigestItem[];
  mentions: DigestItem[];
}
export interface NotificationPreferences {
  channels: Record<NotifType, ChannelPrefs>;
  digest: DigestPrefs;
  /** False when the server has no mail provider - email switches still save, but nothing goes out. */
  emailConfigured: boolean;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  reacted: boolean;
  users: { id: string; name: string }[];
}

export type RelationKind = "blocks" | "blocked_by" | "duplicates" | "relates_to";

export interface TaskRelation {
  id: string;
  relation: RelationKind;
  task: (Task & { status: Status | null }) | null;
}

export interface CycleSummary {
  id: string;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  state: "upcoming" | "active" | "completed";
  progress: { total: number; done: number };
}

export interface SavedView {
  id: string;
  name: string;
  layout: "list" | "board" | "table" | "calendar";
  filters: Record<string, unknown>;
  isShared: boolean;
  createdById: string;
  authorName?: string | null;
}

export interface IntakeQueue {
  id: string;
  name: string;
  spaceId: string;
  targetListId: string | null;
}

export type IntakeItemStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "snoozed"
  | "duplicate";

export interface IntakeItem {
  id: string;
  status: IntakeItemStatus;
  source: string;
  sourceEmail: string | null;
  createdAt: string;
  task: (Task & { status: Status | null }) | null;
}


export type ProjectStatus = "active" | "on_hold" | "completed" | "archived";

export interface ProjectStats {
  tasksTotal: number;
  tasksDone: number;
  /** Row 99 */
  tasksOpen: number;
  tasksOverdue: number;
  loggedSeconds: number;
  billableSeconds: number;
  weekSeconds: number;
  nextMilestone: { id: string; name: string; targetDate: string | null; overdue: boolean } | null;
  channelId: string | null;
  /** Row 100 */
  currentStage: { id: string; name: string; status: StageStatus; index: number; count: number; progressPct: number } | null;
}

export interface Project {
  id: string;
  spaceId: string | null;
  name: string;
  clientName: string | null;
  companyId: string | null;
  company: { id: string; name: string } | null;
  leadId: string | null;
  lead: { id: string; name: string; avatarUrl: string | null } | null;
  description: string | null;
  status: ProjectStatus;
  /** Row 91: "client" project or "internal" time code. */
  kind?: "client" | "internal";
  color: string;
  startDate: string | null;
  endDate: string | null;
  budgetHours: number | null;
  budgetAmount: number | null;
  hourlyRate: number | null;
  currency: string;
  archivedAt: string | null;
  createdAt: string;
  stats: ProjectStats;
  space?: { id: string; name: string; lists: { id: string; name: string }[] } | null;
}

export interface ProjectInput {
  name: string;
  clientName?: string | null;
  companyId?: string | null;
  leadId?: string | null;
  description?: string;
  color?: string;
  status?: ProjectStatus;
  startDate?: string | null;
  endDate?: string | null;
  budgetHours?: number;
  budgetAmount?: number;
  hourlyRate?: number;
  currency?: string;
  spaceId?: string;
}

export interface TimeEntry {
  id: string;
  userId: string;
  projectId: string;
  taskId: string | null;
  description: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  running: boolean;
  billable: boolean;
  source: string;
  project: { id: string; name: string; color: string };
  task: { id: string; title: string; reference: string | null } | null;
  user: { id: string; name: string } | null;
  /** Row 87 */
  stage?: { id: string; name: string } | null;
}

/** Row 98 */
export interface LeaveRequest {
  id: string;
  userId: string;
  kind: "vacation" | "sick" | "personal" | "other";
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  note: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  days: number;
  user?: { id: string; name: string };
  decidedBy?: { id: string; name: string } | null;
}

/** Row 97 */
export interface TimesheetBoard {
  weekStart: string;
  people: {
    userId: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: string;
    hours: number;
    billableHours: number;
    expected: number;
    status: "not_started" | "in_progress" | "submitted" | "approved" | "rejected" | "reopened";
    submissionId: string | null;
    submittedAt: string | null;
    decidedAt: string | null;
    note: string | null;
  }[];
}

/** Row 94 */
export interface ReminderSlot {
  weekday: number;
  hour: number;
  week: "current" | "previous";
}

/** Row 91 */
export interface TimeCode {
  id: string;
  name: string;
  color: string;
  archived: boolean;
}

/** Row 75 */
export interface TimesheetSubmission {
  id: string;
  userId: string;
  weekStart: string;
  status: "submitted" | "approved" | "rejected" | "reopened";
  approverId: string | null;
  totalSeconds: number;
  note: string | null;
  submittedAt: string;
  decidedAt: string | null;
  /** Row 92 */
  decidedBy?: { id: string; name: string } | null;
}

export interface Timesheet {
  userId: string;
  /** Row 75: null until the week is submitted. */
  submission: TimesheetSubmission | null;
  weekStart: string;
  days: string[];
  rows: { projectId: string; projectName: string; color: string; internal?: boolean; taskId: string | null; taskTitle: string | null; taskReference: string | null; hours: number[]; total: number }[];
  totals: number[];
  grandTotal: number;
  /** Row 88: the person's weekly capacity, for "29/40". */
  expectedHours: number;
}

export interface ProjectTimeSummary {
  projectId: string;
  loggedSeconds: number;
  billableSeconds: number;
  billableAmount: number | null;
  budgetHours: number | null;
  budgetAmount: number | null;
  byUser: { userId: string; name: string; seconds: number; billable: number }[];
}

export interface ResourcingCell {
  weekStart: string;
  allocated: number;
  logged: number;
  utilization: number;
  byProject: Record<string, number>;
}

export interface ResourcingBoard {
  weeks: string[];
  projects: { id: string; name: string; color: string }[];
  members: {
    userId: string;
    name: string;
    role: string;
    capacity: number;
    cells: ResourcingCell[];
  }[];
}


/* ---- CRM ---- */

/** Row 51: a project as listed on its client's page. */
export interface CompanyProject {
  id: string;
  name: string;
  color: string;
  status: ProjectStatus;
  startDate: string | null;
  endDate: string | null;
  budgetAmount: number | null;
  currency: string;
  lead: { id: string; name: string } | null;
}

export interface Company {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  owner: { id: string; name: string } | null;
  contactCount?: number;
  openDeals?: number;
  wonValue?: number;
  contacts?: Contact[];
  deals?: Deal[];
  projects?: CompanyProject[];
  createdAt: string;
}

export interface CompanyInput {
  name: string;
  website?: string;
  industry?: string;
  email?: string;
  phone?: string;
  address?: string;
  ownerId?: string | null;
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  isPrimary: boolean;
  company: { id: string; name: string } | null;
  createdAt: string;
}

export interface ContactInput {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
  companyId?: string | null;
  isPrimary?: boolean;
}

/** Row 53: pipeline stages are per-workspace rows; `kind` marks the terminal ones. */
export type DealStageKind = "open" | "won" | "lost";
export interface DealStageRow {
  id: string;
  name: string;
  kind: DealStageKind;
  color: string;
  probability: number;
  position: number;
}
export type DealStageRef = Pick<DealStageRow, "id" | "name" | "kind" | "color">;

export interface Deal {
  id: string;
  title: string;
  value: number;
  currency: string;
  stageId: string | null;
  stage: DealStageRef | null;
  probability: number;
  expectedCloseDate: string | null;
  closedAt: string | null;
  lostReason: string | null;
  /** Row 55 */
  nextActionAt: string | null;
  nextActionNote: string | null;
  lastActivityAt: string;
  idleDays?: number;
  stale?: boolean;
  followUpDue?: boolean;
  position: number;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  createdAt: string;
}

export interface DealInput {
  title: string;
  companyId?: string | null;
  contactId?: string | null;
  value?: number;
  currency?: string;
  stageId?: string;
  probability?: number;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
  ownerId?: string | null;
  nextActionAt?: string | null;
  nextActionNote?: string | null;
}

export interface DealColumn {
  stage: DealStageRow;
  count: number;
  value: number;
  weighted: number;
  deals: Deal[];
}

/* ---- Proposals (rows 56-59) ---- */
export interface ProposalSection {
  key: string;
  title: string;
  body: string;
}
export interface ProposalTemplate {
  id: string;
  name: string;
  sections: ProposalSection[];
  isDefault: boolean;
}
export type ProposalStatus = "draft" | "sent" | "viewed" | "accepted" | "declined";
export interface ProposalRecipient {
  id: string;
  contactId: string | null;
  name: string;
  email: string | null;
  token: string;
  sentAt: string;
  viewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  signerName: string | null;
  signerTitle: string | null;
}
export interface ProposalVersion {
  id: string;
  version: number;
  title: string;
  total: number;
  currency: string;
  sentAt: string;
  sentBy: { id: string; name: string } | null;
  pdfUrl: string | null;
  recipients: ProposalRecipient[];
}
export interface ProposalSummary {
  id: string;
  number: string;
  title: string;
  status: ProposalStatus;
  currency: string;
  total: number;
  validUntil: string | null;
  currentVersion: number;
  acceptedAt: string | null;
  declinedAt: string | null;
  createdAt: string;
  updatedAt: string;
  dealId: string | null;
  companyId: string | null;
  contactId: string | null;
  templateId: string | null;
  deal: { id: string; title: string } | null;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string | null } | null;
  recipientSummary?: { sent: number; viewed: number; accepted: number; declined: number };
}
export interface Proposal extends ProposalSummary {
  sections: ProposalSection[];
  createdBy: { id: string; name: string } | null;
  versions: ProposalVersion[];
}
export interface PublicProposal {
  token: string;
  recipient: { name: string; acceptedAt: string | null; declinedAt: string | null; signerName: string | null; signerTitle: string | null };
  proposal: {
    number: string;
    title: string;
    version: number;
    latest: boolean;
    status: ProposalStatus;
    company: string | null;
    from: string | null;
    currency: string;
    total: number;
    validUntil: string | null;
    expired: boolean;
    sentAt: string;
    sections: ProposalSection[];
    pdfUrl: string | null;
  };
}

export type EstimateStatus = "draft" | "sent" | "accepted" | "declined" | "expired";

export interface EstimateItem {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount?: number;
}

export interface Estimate {
  id: string;
  number: string;
  title: string;
  status: EstimateStatus;
  currency: string;
  issueDate: string | null;
  validUntil: string | null;
  notes: string | null;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  sentAt: string | null;
  acceptedAt: string | null;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string | null } | null;
  deal: { id: string; title: string } | null;
  items: EstimateItem[];
  createdAt: string;
}

export interface EstimateInput {
  title: string;
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  currency?: string;
  issueDate?: string | null;
  validUntil?: string | null;
  notes?: string | null;
  taxRate?: number;
  items?: EstimateItem[];
}

export type NoteEntity = "company" | "contact" | "deal";

export type NoteKind = "note" | "call" | "meeting" | "email";

export interface CrmNote {
  id: string;
  entityType: NoteEntity;
  entityId: string;
  body: string;
  /** Row 54: what kind of interaction, and when it happened. */
  kind: NoteKind;
  occurredAt: string;
  pinned: boolean;
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
  /** Set on a company's log for entries that belong to one of its contacts or deals. */
  about?: { type: NoteEntity; id: string; name: string } | null;
}

export interface Meeting {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  location: string | null;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  deal: { id: string; title: string } | null;
  organizer: { id: string; name: string };
  attendees: { id: string; name: string; avatarUrl: string | null }[];
}

export interface MeetingInput {
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt: string;
  location?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  attendeeIds?: string[];
}

export const api = {
  // ---- Auth ----
  me: () => request<{ user: AuthedUser; memberships: Membership[]; mfa?: MfaState }>(`/auth/me`),
  /** Row 81: two-factor authentication. */
  mfaStatus: () => request<MfaState & { backupCodesLeft: number }>(`/auth/mfa`),
  mfaEnrolled: () => request<{ codes: string[]; left: number }>(`/auth/mfa/enrolled`, { method: "POST" }),
  mfaDisable: () => request<{ enrolled: boolean }>(`/auth/mfa`, { method: "DELETE" }),
  mfaBackupCodes: () => request<{ codes: string[]; left: number }>(`/auth/mfa/backup-codes`, { method: "POST" }),
  mfaUseBackup: (code: string) => request<{ verified: boolean; left: number }>(`/auth/mfa/backup/use`, { method: "POST", body: JSON.stringify({ code }) }),
  getMfaPolicy: () => request<{ mfaRequiredRoles: string[] }>(`/auth/mfa/policy`),
  updateMfaPolicy: (roles: string[]) => request<{ mfaRequiredRoles: string[] }>(`/auth/mfa/policy`, { method: "PATCH", body: JSON.stringify({ roles }) }),
  createOrganization: (name: string) =>
    request<{ id: string; name: string; slug: string; role: Membership["role"] }>(
      `/auth/organizations`,
      { method: "POST", body: JSON.stringify({ name }) },
    ),

  getSpaces: () => request<SpaceTree[]>(`/spaces`),
  getStatuses: (spaceId: string) => request<Status[]>(`/spaces/${spaceId}/statuses`),
  getMembers: () => request<Member[]>(`/members`),
  /** Row 86: everyone, including people who've left. */
  getAllMembers: () => request<Member[]>(`/members?includeDeactivated=true`),
  getOpenWork: (userId: string) =>
    request<{ openTasks: { id: string; title: string; dueDate: string | null }[]; leadOf: { id: string; name: string }[]; timerRunning: boolean }>(`/members/${userId}/open-work`),
  deactivateMember: (userId: string, body: { endDate?: string | null; reassignToUserId?: string | null }) =>
    request<{ userId: string; reassigned: number }>(`/members/${userId}/deactivate`, { method: "POST", body: JSON.stringify(body) }),
  reactivateMember: (userId: string) => request<{ userId: string }>(`/members/${userId}/reactivate`, { method: "POST" }),
  reassignOpenTasks: (userId: string, toUserId: string) =>
    request<{ reassigned: number }>(`/members/${userId}/reassign`, { method: "POST", body: JSON.stringify({ toUserId }) }),
  listTasks: (listId: string) =>
    request<Task[]>(`/tasks?listId=${encodeURIComponent(listId)}`),
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (body: {
    listId: string;
    title: string;
    statusId?: string;
    priority?: Priority | null;
    parentTaskId?: string;
    startDate?: string | null;
    dueDate?: string | null;
    timeEstimateMinutes?: number | null;
    assigneeIds?: string[];
    description?: string;
    companyId?: string | null;
    contactId?: string | null;
    dealId?: string | null;
    sourceMessageId?: string;
  }) => request<Task>(`/tasks`, { method: "POST", body: JSON.stringify(body) }),
  /** Tasks attached to a company / contact / deal (row 38). */
  getCrmTasks: (link: { companyId?: string; contactId?: string; dealId?: string }) => {
    const q = new URLSearchParams();
    if (link.companyId) q.set("companyId", link.companyId);
    if (link.contactId) q.set("contactId", link.contactId);
    if (link.dealId) q.set("dealId", link.dealId);
    return request<MyTask[]>(`/tasks/crm?${q.toString()}`);
  },
  updateTask: (id: string, body: TaskPatch) =>
    request<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  // ---- Statuses (per space; owner/admin) ----
  createStatus: (spaceId: string, body: { name: string; color?: string; category?: Status["category"] }) =>
    request<Status>(`/spaces/${spaceId}/statuses`, { method: "POST", body: JSON.stringify(body) }),
  updateStatus: (id: string, body: Partial<{ name: string; color: string; category: Status["category"] }>) =>
    request<Status>(`/statuses/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  reorderStatuses: (spaceId: string, ids: string[]) =>
    request<Status[]>(`/spaces/${spaceId}/statuses/order`, { method: "PUT", body: JSON.stringify({ ids }) }),
  deleteStatus: (id: string, reassignTo?: string) =>
    request<{ id: string; deleted: boolean; movedTasks: number }>(
      `/statuses/${id}${reassignTo ? "?reassignTo=" + reassignTo : ""}`,
      { method: "DELETE" },
    ),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: "DELETE" }),
  addAssignee: (taskId: string, userId: string) =>
    request<Task>(`/tasks/${taskId}/assignees`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  removeAssignee: (taskId: string, userId: string) =>
    request<Task>(`/tasks/${taskId}/assignees/${userId}`, { method: "DELETE" }),

  // ---- Chat ----
  getChannels: () => request<ChatChannel[]>(`/chat/channels`),
  getMessages: (channelId: string) =>
    request<ChatMessage[]>(`/chat/channels/${channelId}/messages`),
  sendMessage: (channelId: string, body: string, parentMessageId?: string, mentionedUserIds?: string[], attachmentIds?: string[]) =>
    request<ChatMessage>(`/chat/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, parentMessageId, mentionedUserIds, attachmentIds }),
    }),
  // ---- Files (row 43) ----
  uploadFile: (file: File, target: { channelId?: string; taskId?: string }) => {
    const form = new FormData();
    form.append("file", file, file.name);
    if (target.channelId) form.append("channelId", target.channelId);
    if (target.taskId) form.append("taskId", target.taskId);
    return upload<Attachment>(`/files`, form);
  },
  getChannelFiles: (channelId: string) => request<Attachment[]>(`/files?channelId=${channelId}`),
  deleteFile: (id: string) => request<{ id: string; deleted: boolean }>(`/files/${id}`, { method: "DELETE" }),
  /** Row 40: a message's thread (root + replies). */
  getThread: (channelId: string, messageId: string) =>
    request<{ root: ChatMessage; replies: ChatMessage[] }>(`/chat/channels/${channelId}/messages/${messageId}/replies`),
  createChannel: (body: { name: string; isPrivate?: boolean; memberIds?: string[] }) =>
    request<ChatChannel>(`/chat/channels`, { method: "POST", body: JSON.stringify(body) }),
  addChannelMembers: (id: string, userIds: string[]) =>
    request<ChatMember[]>(`/chat/channels/${id}/members`, { method: "POST", body: JSON.stringify({ userIds }) }),
  leaveChannel: (id: string) => request<{ id: string; left: boolean }>(`/chat/channels/${id}/leave`, { method: "POST" }),
  /** Row 50: project channel activity feed. */
  setActivityFeed: (channelId: string, enabled: boolean) =>
    request<{ channelId: string; activityFeed: boolean }>(`/chat/channels/${channelId}/activity-feed`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  /** Row 49: search across my channels. */
  searchMessages: (f: { q?: string; from?: string; in?: string; hasFile?: boolean; after?: string; before?: string }) => {
    const qs = new URLSearchParams();
    if (f.q) qs.set("q", f.q);
    if (f.from) qs.set("from", f.from);
    if (f.in) qs.set("in", f.in);
    if (f.hasFile) qs.set("has", "file");
    if (f.after) qs.set("after", f.after);
    if (f.before) qs.set("before", f.before);
    return request<(ChatMessage & { channel: { id: string; name: string | null; type: "channel" | "dm" } })[]>(`/chat/search?${qs.toString()}`);
  },
  /** Row 46: pins + bookmarks. */
  togglePin: (channelId: string, messageId: string) =>
    request<{ messageId: string; pinnedAt: string | null }>(`/chat/channels/${channelId}/messages/${messageId}/pin`, { method: "POST" }),
  getPinnedMessages: (channelId: string) => request<ChatMessage[]>(`/chat/channels/${channelId}/pins`),
  addChannelBookmark: (channelId: string, body: { label: string; url: string }) =>
    request<ChannelBookmark>(`/chat/channels/${channelId}/bookmarks`, { method: "POST", body: JSON.stringify(body) }),
  removeChannelBookmark: (channelId: string, bookmarkId: string) =>
    request<{ id: string; removed: boolean }>(`/chat/channels/${channelId}/bookmarks/${bookmarkId}`, { method: "DELETE" }),
  /** Row 45: per-channel notification rule. */
  setChannelNotify: (id: string, notify: ChannelNotify) =>
    request<{ channelId: string; notify: ChannelNotify }>(`/chat/channels/${id}/notify`, { method: "PATCH", body: JSON.stringify({ notify }) }),
  /** Row 44: toggle an emoji on a message. */
  reactToMessage: (channelId: string, messageId: string, emoji: string) =>
    request<{ messageId: string; parentMessageId: string | null; reactions: ReactionGroup[] }>(`/chat/channels/${channelId}/messages/${messageId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    }),
  /** Row 42: I've read this channel up to now (synced to my other devices). */
  markChannelRead: (id: string) => request<{ channelId: string; lastReadAt: string }>(`/chat/channels/${id}/read`, { method: "POST" }),
  // ---- Projects: team (row 39) ----
  getProjectMembers: (projectId: string) => request<ProjectMember[]>(`/projects/${projectId}/members`),
  addProjectMembers: (projectId: string, userIds: string[]) =>
    request<ProjectMember[]>(`/projects/${projectId}/members`, { method: "POST", body: JSON.stringify({ userIds }) }),
  /** Row 85 */
  setProjectMemberRole: (projectId: string, userId: string, role: ProjectRole) =>
    request<ProjectMember[]>(`/projects/${projectId}/members/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeProjectMember: (projectId: string, userId: string) =>
    request<ProjectMember[]>(`/projects/${projectId}/members/${userId}`, { method: "DELETE" }),

  // ---- Activity & collaboration ----
  getActivity: (taskId: string) => request<ActivityEntry[]>(`/tasks/${taskId}/activity`),
  addComment: (
    taskId: string,
    body: { body: string; mentionedUserIds?: string[]; assigneeId?: string },
  ) =>
    request<TaskComment>(`/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getAssignedComments: (includeResolved = false) =>
    request<TaskComment[]>(`/comments/assigned${includeResolved ? "?resolved=true" : ""}`),
  getAssignedCommentsCount: () => request<{ count: number }>(`/comments/assigned/count`),
  assignComment: (id: string, assigneeId: string | null) =>
    request<TaskComment>(`/comments/${id}/assign`, {
      method: "PATCH",
      body: JSON.stringify({ assigneeId }),
    }),
  resolveComment: (id: string, resolved: boolean) =>
    request<TaskComment>(`/comments/${id}/resolve`, {
      method: "PATCH",
      body: JSON.stringify({ resolved }),
    }),
  getMyTasks: (includeDone = false) => request<MyTask[]>(`/tasks/mine${includeDone ? "?includeDone=true" : ""}`),
  bulkUpdateTasks: (ids: string[], patch: BulkTaskPatch) =>
    request<{ updated: number; failed: { id: string; error?: string }[] }>(`/tasks/bulk`, {
      method: "PATCH",
      body: JSON.stringify({ ids, patch }),
    }),
  completeTask: (id: string) => request<Task>(`/tasks/${id}/complete`, { method: "POST" }),
  reopenTask: (id: string) => request<Task>(`/tasks/${id}/reopen`, { method: "POST" }),
  getRelations: (taskId: string) => request<TaskRelation[]>(`/tasks/${taskId}/relations`),
  addRelation: (taskId: string, relatedTaskId: string, relation: RelationKind) =>
    request<TaskRelation[]>(`/tasks/${taskId}/relations`, {
      method: "POST",
      body: JSON.stringify({ relatedTaskId, relation }),
    }),
  removeRelation: (taskId: string, relationId: string) =>
    request<TaskRelation[]>(`/tasks/${taskId}/relations/${relationId}`, {
      method: "DELETE",
    }),
  getSubscription: (taskId: string) =>
    request<{ subscribed: boolean }>(`/tasks/${taskId}/subscription`),
  subscribeTask: (taskId: string) =>
    request<{ subscribed: boolean }>(`/tasks/${taskId}/subscribe`, { method: "POST" }),
  unsubscribeTask: (taskId: string) =>
    request<{ subscribed: boolean }>(`/tasks/${taskId}/subscribe`, { method: "DELETE" }),

  // ---- Reactions ----
  getReactions: (entityType: "task" | "comment" | "message", entityId: string) =>
    request<ReactionGroup[]>(`/reactions/${entityType}/${entityId}`),
  toggleReaction: (
    entityType: "task" | "comment" | "message",
    entityId: string,
    emoji: string,
  ) =>
    request<ReactionGroup[]>(`/reactions/${entityType}/${entityId}`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    }),

  // ---- Notifications ----
  getNotifications: (tab: InboxTab = "all") =>
    request<AppNotification[]>(`/notifications?tab=${tab}`),
  getUnreadCount: () => request<UnreadCounts>(`/notifications/unread-count`),
  toggleNotificationImportant: (id: string) =>
    request<AppNotification>(`/notifications/${id}/important`, { method: "PATCH" }),
  restoreNotification: (id: string) =>
    request<AppNotification>(`/notifications/${id}/restore`, { method: "PATCH" }),
  clearAllNotifications: (tab?: TypedInboxTab) =>
    request<{ ok: boolean }>(`/notifications/clear-all`, {
      method: "POST",
      body: JSON.stringify(tab ? { tab } : {}),
    }),
  markNotificationRead: (id: string) =>
    request<AppNotification>(`/notifications/${id}/read`, { method: "PATCH" }),
  markAllNotificationsRead: (tab?: TypedInboxTab) =>
    request<{ ok: boolean }>(`/notifications/read-all`, {
      method: "POST",
      body: JSON.stringify(tab ? { tab } : {}),
    }),
  archiveNotification: (id: string) =>
    request<AppNotification>(`/notifications/${id}/archive`, { method: "PATCH" }),
  snoozeNotification: (id: string, until: string) =>
    request<AppNotification>(`/notifications/${id}/snooze`, {
      method: "PATCH",
      body: JSON.stringify({ until }),
    }),
  /** Row 76: digest. */
  previewDigest: () => request<DigestSections>(`/notifications/digest/preview`),
  sendDigestNow: () => request<{ sent: boolean; sections: DigestSections }>(`/notifications/digest/send`, { method: "POST" }),
  /** Row 75: approve / reject from the inbox card. */
  decideApproval: (id: string, body: { approve: boolean; note?: string }) =>
    request<AppNotification>(`/notifications/${id}/decide`, { method: "POST", body: JSON.stringify(body) }),
  /** Row 77: follows. */
  getFollows: () => request<NotificationMute[]>(`/notifications/follows`),
  followEntity: (entityType: MutableEntity, entityId: string) =>
    request<{ following: boolean }>(`/notifications/follows`, { method: "POST", body: JSON.stringify({ entityType, entityId }) }),
  unfollowEntity: (entityType: MutableEntity, entityId: string) =>
    request<{ following: boolean }>(`/notifications/follows/${entityType}/${entityId}`, { method: "DELETE" }),
  /** Row 74: mutes. */
  getMutes: () => request<NotificationMute[]>(`/notifications/mutes`),
  muteEntity: (entityType: MutableEntity, entityId: string) =>
    request<{ muted: boolean }>(`/notifications/mutes`, { method: "POST", body: JSON.stringify({ entityType, entityId }) }),
  unmuteEntity: (entityType: MutableEntity, entityId: string) =>
    request<{ muted: boolean }>(`/notifications/mutes/${entityType}/${entityId}`, { method: "DELETE" }),
  getNotificationPreferences: () =>
    request<NotificationPreferences>(`/notifications/preferences`),
  updateNotificationPreferences: (patch: Partial<Record<NotifType, Partial<ChannelPrefs>>> & { digest?: Partial<DigestPrefs> }) =>
    request<NotificationPreferences>(`/notifications/preferences`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // ---- Cycles ----
  getCycles: (spaceId: string) =>
    request<CycleSummary[]>(`/cycles?spaceId=${encodeURIComponent(spaceId)}`),
  createCycle: (body: {
    spaceId: string;
    name: string;
    startDate?: string;
    endDate?: string;
  }) => request<CycleSummary>(`/cycles`, { method: "POST", body: JSON.stringify(body) }),
  getCycleTasks: (cycleId: string) => request<Task[]>(`/cycles/${cycleId}/tasks`),
  addTaskToCycle: (cycleId: string, taskId: string) =>
    request<{ ok: boolean }>(`/cycles/${cycleId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ taskId }),
    }),
  removeTaskFromCycle: (taskId: string) =>
    request<{ ok: boolean }>(`/cycles/tasks/${taskId}`, { method: "DELETE" }),

  // ---- Saved views ----
  getViews: (listId: string) =>
    request<SavedView[]>(`/views?listId=${encodeURIComponent(listId)}`),
  createView: (body: {
    name: string;
    listId?: string;
    spaceId?: string;
    layout?: SavedView["layout"];
    filters: Record<string, unknown>;
    isShared?: boolean;
  }) => request<SavedView>(`/views`, { method: "POST", body: JSON.stringify(body) }),
  updateView: (id: string, body: Partial<{ name: string; layout: SavedView["layout"]; filters: Record<string, unknown>; isShared: boolean }>) =>
    request<SavedView>(`/views/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteView: (id: string) => request<void>(`/views/${id}`, { method: "DELETE" }),

  // ---- Intake ----
  getIntakes: (spaceId: string) =>
    request<IntakeQueue[]>(`/intake?spaceId=${encodeURIComponent(spaceId)}`),
  ensureIntake: (spaceId: string, targetListId?: string) =>
    request<IntakeQueue>(`/intake`, {
      method: "POST",
      body: JSON.stringify({ spaceId, targetListId }),
    }),
  getIntakeItems: (intakeId: string, status?: string) =>
    request<IntakeItem[]>(
      `/intake/${intakeId}/items${status ? "?status=" + status : ""}`,
    ),
  submitIntake: (body: { intakeId: string; title: string; description?: string }) =>
    request<IntakeItem>(`/intake/submit`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  decideIntake: (
    itemId: string,
    body: {
      decision: IntakeItemStatus;
      snoozedTill?: string;
      duplicateToTaskId?: string;
    },
  ) =>
    request<IntakeItem>(`/intake/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  // ---- Projects ----
  getProjects: (archived = false) =>
    request<Project[]>(`/projects${archived ? "?archived=true" : ""}`),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  // ---- Task list templates ----
  getTaskTemplates: () => request<TaskTemplate[]>(`/task-templates`),
  createTemplateFromList: (body: { listId: string; name: string; description?: string }) =>
    request<TaskTemplate>(`/task-templates/from-list`, { method: "POST", body: JSON.stringify(body) }),
  updateTaskTemplate: (id: string, body: { name?: string; description?: string | null }) =>
    request<TaskTemplate>(`/task-templates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTaskTemplate: (id: string) => request<{ id: string }>(`/task-templates/${id}`, { method: "DELETE" }),
  applyTaskTemplate: (id: string, body: { projectId: string; listId?: string }) =>
    request<{ listId: string; tasksCreated: number; subtasksCreated: number; milestonesCreated: number }>(
      `/task-templates/${id}/apply`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  getProjectLists: (projectId: string) => request<{ id: string; name: string }[]>(`/task-templates/project-lists/${projectId}`),
  // ---- Milestones ----
  getMilestones: (projectId: string) => request<Milestone[]>(`/projects/${projectId}/milestones`),
  /** Row 106 */
  getAtRiskMilestones: () => request<{ days: number; items: AtRiskMilestone[] }>(`/milestones/at-risk`),
  getMilestoneRisk: () => request<{ days: number }>(`/milestones/risk-settings`),
  setMilestoneRisk: (days: number) => request<{ days: number }>(`/milestones/risk-settings`, { method: "PATCH", body: JSON.stringify({ days }) }),
  getMilestonesForSpace: (spaceId: string) => request<Milestone[]>(`/milestones?spaceId=${encodeURIComponent(spaceId)}`),
  createMilestone: (projectId: string, body: MilestoneWrite & { name: string }) =>
    request<Milestone>(`/projects/${projectId}/milestones`, { method: "POST", body: JSON.stringify(body) }),
  updateMilestone: (id: string, body: MilestoneWrite) =>
    request<Milestone>(`/milestones/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMilestone: (id: string) => request<{ id: string }>(`/milestones/${id}`, { method: "DELETE" }),
  /** Row 78: email-in to a project. */
  getInboundEmail: (projectId: string) =>
    request<{ address: string; token: string; domain: string; configured: boolean }>(`/projects/${projectId}/inbound-email`),
  regenerateInboundEmail: (projectId: string) =>
    request<{ address: string; token: string; domain: string; configured: boolean }>(`/projects/${projectId}/inbound-email/regenerate`, { method: "POST" }),
  testInboundEmail: (projectId: string, body: { from: string; subject: string; text?: string; attachments?: { name: string; contentType: string; contentBase64: string }[] }) =>
    request<{ kind: "task" | "comment"; taskId: string; projectId: string }>(`/projects/${projectId}/inbound-email/test`, { method: "POST", body: JSON.stringify(body) }),
  /** Row 75: milestone sign-off. */
  requestMilestoneSignoff: (id: string, body: { approverId?: string } = {}) =>
    request<Milestone>(`/milestones/${id}/signoff`, { method: "POST", body: JSON.stringify(body) }),
  decideMilestoneSignoff: (id: string, body: { approve: boolean; note?: string }) =>
    request<Milestone>(`/milestones/${id}/signoff/decision`, { method: "POST", body: JSON.stringify(body) }),
  // ---- Project stages ----
  getStages: (projectId: string) => request<Stage[]>(`/projects/${projectId}/stages`),
  getStagesForSpace: (spaceId: string) => request<Stage[]>(`/stages?spaceId=${encodeURIComponent(spaceId)}`),
  createStage: (projectId: string, name: string) =>
    request<Stage>(`/projects/${projectId}/stages`, { method: "POST", body: JSON.stringify({ name }) }),
  reorderStages: (projectId: string, ids: string[]) =>
    request<Stage[]>(`/projects/${projectId}/stages/order`, { method: "PUT", body: JSON.stringify({ ids }) }),
  applyStageTemplate: (projectId: string, templateId: string) =>
    request<Stage[]>(`/projects/${projectId}/stages/apply-template`, { method: "POST", body: JSON.stringify({ templateId }) }),
  updateStage: (id: string, body: { name?: string; status?: StageStatus; note?: string }) =>
    request<Stage>(`/stages/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteStage: (id: string) => request<{ id: string }>(`/stages/${id}`, { method: "DELETE" }),
  /** Row 105 */
  setStageProgress: (id: string, body: { pct: number; note?: string }) =>
    request<Stage>(`/stages/${id}/progress`, { method: "PATCH", body: JSON.stringify(body) }),
  getStageProgressHistory: (id: string) => request<StageProgressEvent[]>(`/stages/${id}/progress`),
  getStageActivity: (id: string) => request<ActivityEntry[]>(`/stages/${id}/activity`),
  /** Row 102 */
  getProjectActivity: (projectId: string, limit = 150) => request<ProjectActivity>(`/projects/${projectId}/activity?limit=${limit}`),
  getStageTemplates: () => request<StageTemplate[]>(`/stage-templates`),
  createStageTemplate: (body: { name: string; stages: string[]; isDefault?: boolean }) =>
    request<StageTemplate>(`/stage-templates`, { method: "POST", body: JSON.stringify(body) }),
  updateStageTemplate: (id: string, body: Partial<{ name: string; stages: string[]; isDefault: boolean }>) =>
    request<StageTemplate>(`/stage-templates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteStageTemplate: (id: string) => request<{ id: string }>(`/stage-templates/${id}`, { method: "DELETE" }),
  createProject: (body: ProjectInput) =>
    request<Project>(`/projects`, { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, body: Partial<ProjectInput>) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveProject: (id: string) =>
    request<{ id: string; archived: boolean }>(`/projects/${id}`, { method: "DELETE" }),

  // ---- Time tracking ----
  /** Row 91: internal time codes (admin, training, PTO…). */
  getTimeCodes: (includeArchived = false) => request<TimeCode[]>(`/time/codes${includeArchived ? "?includeArchived=true" : ""}`),
  createTimeCode: (body: { name: string; color?: string }) => request<TimeCode>(`/time/codes`, { method: "POST", body: JSON.stringify(body) }),
  updateTimeCode: (id: string, body: { name?: string; color?: string; archived?: boolean }) =>
    request<TimeCode>(`/time/codes/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  getRunningTimer: () => request<TimeEntry | null>(`/time/running`),
  startTimer: (body: { projectId?: string; taskId?: string; description?: string; billable?: boolean }) =>
    request<TimeEntry>(`/time/start`, { method: "POST", body: JSON.stringify(body) }),
  stopTimer: () => request<TimeEntry | null>(`/time/stop`, { method: "POST" }),
  getTimeEntries: (opts: { userId?: string; projectId?: string; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v) q.set(k, v);
    const qs = q.toString();
    return request<TimeEntry[]>(`/time/entries${qs ? "?" + qs : ""}`);
  },
  /** Row 87 */
  getPickableTasks: (projectId: string) =>
    request<{ id: string; title: string; reference: string | null }[]>(`/time/pickable-tasks?projectId=${encodeURIComponent(projectId)}`),
  createTimeEntry: (body: {
    projectId: string;
    taskId?: string;
    stageId?: string;
    description?: string;
    billable?: boolean;
    startedAt: string;
    durationSeconds?: number;
    endedAt?: string;
  }) => request<TimeEntry>(`/time/entries`, { method: "POST", body: JSON.stringify(body) }),
  updateTimeEntry: (
    id: string,
    body: { description?: string; billable?: boolean; durationSeconds?: number; taskId?: string | null },
  ) => request<TimeEntry>(`/time/entries/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTimeEntry: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/time/entries/${id}`, { method: "DELETE" }),
  getTimesheet: (week?: string, userId?: string) => {
    const q = new URLSearchParams();
    if (week) q.set("week", week);
    if (userId) q.set("userId", userId);
    const qs = q.toString();
    return request<Timesheet>(`/time/timesheet${qs ? "?" + qs : ""}`);
  },
  /** Row 75 */
  submitTimesheet: (week: string, approverId?: string) =>
    request<TimesheetSubmission>(`/time/timesheet/submit`, { method: "POST", body: JSON.stringify({ week, approverId }) }),
  /** Row 98: time off. */
  getLeave: (opts: { from?: string; to?: string; all?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    if (opts.all) q.set("all", "true");
    const qs = q.toString();
    return request<LeaveRequest[]>(`/time/leave${qs ? "?" + qs : ""}`);
  },
  getLeaveCalendar: (from: string, to: string) =>
    request<{ id: string; userId: string; name: string; kind: string; status: string; startDate: string; endDate: string; days: number }[]>(`/time/leave/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  requestLeave: (body: { kind: LeaveRequest["kind"]; startDate: string; endDate: string; note?: string; hoursPerDay?: number }) =>
    request<LeaveRequest>(`/time/leave`, { method: "POST", body: JSON.stringify(body) }),
  decideLeave: (id: string, body: { approve: boolean; note?: string }) =>
    request<{ id: string; status: string }>(`/time/leave/${id}/decision`, { method: "POST", body: JSON.stringify(body) }),
  cancelLeave: (id: string) => request<{ id: string; status: string }>(`/time/leave/${id}`, { method: "DELETE" }),
  /** Row 97 */
  /** Row 103 */
  getWorkload: (week: string) => request<TeamWorkload>(`/time/workload?week=${encodeURIComponent(week)}`),
  getTimesheetBoard: (week: string) => request<TimesheetBoard>(`/time/timesheet/board?week=${encodeURIComponent(week)}`),
  nudgeTimesheet: (userId: string, week: string) => request<{ nudged: string }>(`/time/timesheet/board/nudge`, { method: "POST", body: JSON.stringify({ userId, week }) }),
  /** Row 94 */
  getTimesheetReminders: () => request<ReminderSlot[]>(`/time/timesheet/reminders`),
  setTimesheetReminders: (slots: ReminderSlot[]) => request<ReminderSlot[]>(`/time/timesheet/reminders`, { method: "PUT", body: JSON.stringify({ slots }) }),
  previewTimesheetReminder: (week: "current" | "previous") =>
    request<{ weekStart: string; people: { userId: string; hours: number; expected: number; submitted: boolean }[] }>(`/time/timesheet/reminders/preview?week=${week}`),
  sendTimesheetReminderNow: (slot: ReminderSlot) => request<{ sent: number }>(`/time/timesheet/reminders/send`, { method: "POST", body: JSON.stringify(slot) }),
  /** Row 93 */
  reopenTimesheet: (id: string, reason: string) =>
    request<TimesheetSubmission>(`/time/timesheet/submissions/${id}/reopen`, { method: "POST", body: JSON.stringify({ reason }) }),
  getTimesheetEvents: (id: string) =>
    request<{ id: string; kind: string; note: string | null; createdAt: string; actor: { id: string; name: string } | null }[]>(`/time/timesheet/submissions/${id}/events`),
  /** Row 104 */
  getPendingTimesheets: () => request<PendingTimesheet[]>(`/time/timesheet/pending`),
  decideTimesheet: (id: string, body: { approve: boolean; note?: string }) =>
    request<TimesheetSubmission>(`/time/timesheet/submissions/${id}/decision`, { method: "POST", body: JSON.stringify(body) }),
  setTimesheetCell: (body: { projectId: string; taskId?: string | null; date: string; hours: number; userId?: string }) =>
    request<{ ok: boolean }>(`/time/timesheet`, { method: "PUT", body: JSON.stringify(body) }),
  getProjectTimeSummary: (projectId: string) =>
    request<ProjectTimeSummary>(`/time/summary/${projectId}`),

  // ---- Resourcing ----
  getResourcing: (from?: string, weeks = 8) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    q.set("weeks", String(weeks));
    return request<ResourcingBoard>(`/resourcing?${q.toString()}`);
  },
  setAllocation: (body: { userId: string; projectId: string; weekStart: string; hours: number; note?: string }) =>
    request<{ ok: boolean }>(`/resourcing/allocations`, { method: "PUT", body: JSON.stringify(body) }),
  setCapacity: (userId: string, hours: number) =>
    request<{ userId: string; weeklyCapacityHours: number }>(`/resourcing/capacity/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ hours }),
    }),

  // ---- CRM: companies & contacts ----
  getCompanies: (q?: string) =>
    request<Company[]>(`/crm/companies${q ? "?q=" + encodeURIComponent(q) : ""}`),
  getCompany: (id: string) => request<Company>(`/crm/companies/${id}`),
  createCompany: (body: CompanyInput) =>
    request<Company>(`/crm/companies`, { method: "POST", body: JSON.stringify(body) }),
  updateCompany: (id: string, body: Partial<CompanyInput>) =>
    request<Company>(`/crm/companies/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveCompany: (id: string) =>
    request<{ id: string }>(`/crm/companies/${id}`, { method: "DELETE" }),
  getContacts: (opts: { companyId?: string; q?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.companyId) q.set("companyId", opts.companyId);
    if (opts.q) q.set("q", opts.q);
    const qs = q.toString();
    return request<Contact[]>(`/crm/contacts${qs ? "?" + qs : ""}`);
  },
  createContact: (body: ContactInput) =>
    request<Contact>(`/crm/contacts`, { method: "POST", body: JSON.stringify(body) }),
  updateContact: (id: string, body: Partial<ContactInput>) =>
    request<Contact>(`/crm/contacts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveContact: (id: string) =>
    request<{ id: string }>(`/crm/contacts/${id}`, { method: "DELETE" }),

  // ---- CRM: deals ----
  getDeals: () => request<Deal[]>(`/crm/deals`),
  getDealBoard: (staleDays?: number) => request<DealColumn[]>(`/crm/deals/board${staleDays ? `?staleDays=${staleDays}` : ""}`),
  getDeal: (id: string) => request<Deal>(`/crm/deals/${id}`),
  createDeal: (body: DealInput) =>
    request<Deal>(`/crm/deals`, { method: "POST", body: JSON.stringify(body) }),
  updateDeal: (id: string, body: Partial<DealInput>) =>
    request<Deal>(`/crm/deals/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  moveDeal: (id: string, stageId: string, position: number) =>
    request<Deal>(`/crm/deals/${id}/move`, { method: "PATCH", body: JSON.stringify({ stageId, position }) }),
  // ---- CRM: pipeline stages (row 53) ----
  getDealStages: () => request<DealStageRow[]>(`/crm/deals/stages`),
  createDealStage: (body: { name: string; kind?: DealStageKind; probability?: number; color?: string }) =>
    request<DealStageRow>(`/crm/deals/stages`, { method: "POST", body: JSON.stringify(body) }),
  updateDealStage: (id: string, body: Partial<{ name: string; kind: DealStageKind; probability: number; color: string }>) =>
    request<DealStageRow>(`/crm/deals/stages/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  reorderDealStages: (ids: string[]) => request<DealStageRow[]>(`/crm/deals/stages/order`, { method: "PUT", body: JSON.stringify({ ids }) }),
  deleteDealStage: (id: string, moveTo?: string) =>
    request<DealStageRow[]>(`/crm/deals/stages/${id}${moveTo ? `?moveTo=${moveTo}` : ""}`, { method: "DELETE" }),
  convertDeal: (id: string) => request<Deal>(`/crm/deals/${id}/convert`, { method: "POST" }),
  archiveDeal: (id: string) => request<{ id: string }>(`/crm/deals/${id}`, { method: "DELETE" }),

  // ---- CRM: proposals (rows 56-59) ----
  getProposalTemplates: () => request<ProposalTemplate[]>(`/crm/proposal-templates`),
  createProposalTemplate: (body: { name: string; sections?: ProposalSection[]; isDefault?: boolean }) =>
    request<ProposalTemplate>(`/crm/proposal-templates`, { method: "POST", body: JSON.stringify(body) }),
  updateProposalTemplate: (id: string, body: Partial<{ name: string; sections: ProposalSection[]; isDefault: boolean }>) =>
    request<ProposalTemplate>(`/crm/proposal-templates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProposalTemplate: (id: string) => request<{ id: string }>(`/crm/proposal-templates/${id}`, { method: "DELETE" }),
  getProposals: (opts: { dealId?: string; companyId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.dealId) q.set("dealId", opts.dealId);
    if (opts.companyId) q.set("companyId", opts.companyId);
    const qs = q.toString();
    return request<ProposalSummary[]>(`/crm/proposals${qs ? "?" + qs : ""}`);
  },
  createProposal: (body: { dealId: string; templateId?: string; title?: string }) =>
    request<Proposal>(`/crm/proposals`, { method: "POST", body: JSON.stringify(body) }),
  getProposal: (id: string) => request<Proposal>(`/crm/proposals/${id}`),
  updateProposal: (id: string, body: Partial<{ title: string; sections: ProposalSection[]; currency: string; total: number; validUntil: string | null; companyId: string | null; contactId: string | null }>) =>
    request<Proposal>(`/crm/proposals/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  sendProposal: (id: string, recipients: { contactId?: string; name?: string; email?: string }[]) =>
    request<Proposal>(`/crm/proposals/${id}/send`, { method: "POST", body: JSON.stringify({ recipients }) }),
  archiveProposal: (id: string) => request<{ id: string }>(`/crm/proposals/${id}`, { method: "DELETE" }),
  // public (client-facing, no auth)
  getPublicProposal: (token: string) => publicRequest<PublicProposal>(`/public/proposals/${token}`),
  acceptPublicProposal: (token: string, body: { signerName: string; signerTitle?: string; agreed: boolean }) =>
    publicRequest<PublicProposal>(`/public/proposals/${token}/accept`, { method: "POST", body: JSON.stringify(body) }),
  declinePublicProposal: (token: string, reason?: string) =>
    publicRequest<PublicProposal>(`/public/proposals/${token}/decline`, { method: "POST", body: JSON.stringify({ reason }) }),

  // ---- CRM: estimates ----
  getEstimates: (opts: { companyId?: string; dealId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.companyId) q.set("companyId", opts.companyId);
    if (opts.dealId) q.set("dealId", opts.dealId);
    const qs = q.toString();
    return request<Estimate[]>(`/crm/estimates${qs ? "?" + qs : ""}`);
  },
  getEstimate: (id: string) => request<Estimate>(`/crm/estimates/${id}`),
  createEstimate: (body: EstimateInput) =>
    request<Estimate>(`/crm/estimates`, { method: "POST", body: JSON.stringify(body) }),
  updateEstimate: (id: string, body: Partial<EstimateInput>) =>
    request<Estimate>(`/crm/estimates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  setEstimateStatus: (id: string, status: EstimateStatus) =>
    request<Estimate>(`/crm/estimates/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  archiveEstimate: (id: string) =>
    request<{ id: string }>(`/crm/estimates/${id}`, { method: "DELETE" }),

  // ---- CRM: notes & meetings ----
  getNotes: (entityType: NoteEntity, entityId: string) =>
    request<CrmNote[]>(`/crm/notes/${entityType}/${entityId}`),
  addNote: (entityType: NoteEntity, entityId: string, body: { body: string; kind?: NoteKind; occurredAt?: string | null }) =>
    request<CrmNote>(`/crm/notes/${entityType}/${entityId}`, { method: "POST", body: JSON.stringify(body) }),
  pinNote: (id: string) => request<CrmNote>(`/crm/notes/${id}/pin`, { method: "PATCH" }),
  deleteNote: (id: string) => request<{ id: string }>(`/crm/notes/${id}`, { method: "DELETE" }),
  getMeetings: (opts: { from?: string; to?: string; mine?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    if (opts.mine) q.set("mine", "true");
    const qs = q.toString();
    return request<Meeting[]>(`/crm/meetings${qs ? "?" + qs : ""}`);
  },
  createMeeting: (body: MeetingInput) =>
    request<Meeting>(`/crm/meetings`, { method: "POST", body: JSON.stringify(body) }),
  updateMeeting: (id: string, body: Partial<MeetingInput>) =>
    request<Meeting>(`/crm/meetings/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMeeting: (id: string) => request<{ id: string }>(`/crm/meetings/${id}`, { method: "DELETE" }),

  // ---- Workspace structure, tags, members ----
  createSpace: (body: { name: string; color?: string }) =>
    request<{ id: string; name: string; color: string | null; firstListId: string }>(`/spaces`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createList: (spaceId: string, name: string, folderId?: string) =>
    request<{ id: string; name: string; spaceId: string }>(`/spaces/${spaceId}/lists`, {
      method: "POST",
      body: JSON.stringify({ name, folderId }),
    }),
  getSpaceOverview: (spaceId: string) => request<SpaceOverview>(`/spaces/${spaceId}/overview`),
  createFolder: (spaceId: string, name: string) =>
    request<{ id: string; name: string; spaceId: string }>(`/spaces/${spaceId}/folders`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  addBookmark: (spaceId: string, body: { title: string; url: string }) =>
    request<{ id: string; title: string; url: string }>(`/spaces/${spaceId}/bookmarks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeBookmark: (spaceId: string, id: string) =>
    request<{ id: string }>(`/spaces/${spaceId}/bookmarks/${id}`, { method: "DELETE" }),
  getTags: (opts: { usage?: boolean } = {}) => request<Tag[]>(`/tags${opts.usage ? "?usage=true" : ""}`),
  createTag: (body: { name: string; color?: string }) =>
    request<Tag>(`/tags`, { method: "POST", body: JSON.stringify(body) }),
  updateTag: (id: string, body: { name?: string; color?: string }) =>
    request<Tag>(`/tags/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  mergeTag: (id: string, into: string) =>
    request<{ merged: string; into: string }>(`/tags/${id}/merge`, { method: "POST", body: JSON.stringify({ into }) }),
  retireTag: (id: string) => request<{ id: string }>(`/tags/${id}`, { method: "DELETE" }),
  addTaskTag: (taskId: string, tagId: string) =>
    request<Task>(`/tasks/${taskId}/tags`, { method: "POST", body: JSON.stringify({ tagId }) }),
  removeTaskTag: (taskId: string, tagId: string) =>
    request<Task>(`/tasks/${taskId}/tags/${tagId}`, { method: "DELETE" }),
  inviteMember: (body: { email: string; name?: string; role?: "admin" | "member" | "guest" }) =>
    request<Member>(`/members/invite`, { method: "POST", body: JSON.stringify(body) }),
  setMemberRole: (userId: string, role: "admin" | "member" | "guest") =>
    request<{ userId: string; role: string }>(`/members/${userId}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  /** Row 83: invitations. */
  getInvitations: () => request<Invitation[]>(`/invitations`),
  resendInvitation: (id: string) => request<{ id: string; lastSentAt: string; sent: boolean }>(`/invitations/${id}/resend`, { method: "POST" }),
  revokeInvitation: (id: string) => request<{ id: string; revoked: boolean }>(`/invitations/${id}`, { method: "DELETE" }),
  getInvitation: (token: string) =>
    publicRequest<{ email: string; role: string; organization: string; invitedBy: string | null; status: "pending" | "accepted" | "revoked" }>(`/public/invitations/${token}`),
  /** Row 82: hand the workspace to another member (owner only). */
  transferOwnership: (userId: string) =>
    request<{ ownerId: string }>(`/members/${userId}/transfer-ownership`, { method: "POST" }),
  removeMember: (userId: string) =>
    request<{ userId: string }>(`/members/${userId}`, { method: "DELETE" }),

  // ---- Chat: discovery ----
  browseChannels: () =>
    request<{ id: string; name: string | null; topic: string | null; isPrivate: boolean; projectId: string | null; memberCount: number; joined: boolean }[]>(
      `/chat/browse`,
    ),
  joinChannel: (id: string) =>
    request<{ id: string; joined: boolean }>(`/chat/channels/${id}/join`, { method: "POST" }),
  openDm: (userId: string) =>
    request<{ id: string; created: boolean }>(`/chat/dm`, { method: "POST", body: JSON.stringify({ userId }) }),
  /** Row 39: a group DM with several people (same set → same conversation). */
  openGroupDm: (userIds: string[]) =>
    request<{ id: string; created: boolean }>(`/chat/dm`, { method: "POST", body: JSON.stringify({ userIds }) }),

  // ---- Documents ----
  getDocuments: (opts: { projectId?: string; q?: string; entityType?: DocLinkEntity; entityId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.projectId) qs.set("projectId", opts.projectId);
    if (opts.q) qs.set("q", opts.q);
    if (opts.entityType && opts.entityId) {
      qs.set("entityType", opts.entityType);
      qs.set("entityId", opts.entityId);
    }
    const query = qs.toString();
    return request<DocSummary[]>(`/documents${query ? "?" + query : ""}`);
  },
  getDocument: (id: string) => request<Doc>(`/documents/${id}`),
  createDocument: (body: DocWrite & { title: string }) =>
    request<Doc>(`/documents`, { method: "POST", body: JSON.stringify(body) }),
  updateDocument: (id: string, body: DocWrite) =>
    request<Doc>(`/documents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  duplicateDocument: (id: string) => request<Doc>(`/documents/${id}/duplicate`, { method: "POST" }),
  deleteDocument: (id: string) => request<{ id: string }>(`/documents/${id}`, { method: "DELETE" }),
  /** Row 70: supersede. */
  supersedeDoc: (id: string, body: { byDocumentId: string; effectiveFrom?: string | null }) =>
    request<Doc>(`/documents/${id}/supersede`, { method: "POST", body: JSON.stringify(body) }),
  unsupersedeDoc: (id: string) => request<Doc>(`/documents/${id}/supersede`, { method: "DELETE" }),
  /** Row 69: recent & starred. */
  getRecentDocs: () => request<DocSummary[]>(`/documents/recent`),
  getStarredDocs: () => request<DocSummary[]>(`/documents/starred`),
  toggleDocStar: (id: string) => request<{ documentId: string; starred: boolean }>(`/documents/${id}/star`, { method: "POST" }),
  /** Row 68: doc starter kit. */
  getDocTemplates: () => request<DocTemplate[]>(`/doc-templates`),
  createDocTemplate: (body: { title: string; icon?: string | null; content?: Record<string, unknown> | null; inKit?: boolean }) =>
    request<DocTemplate>(`/doc-templates`, { method: "POST", body: JSON.stringify(body) }),
  updateDocTemplate: (id: string, body: Partial<{ title: string; icon: string | null; content: Record<string, unknown> | null; body: string; inKit: boolean }>) =>
    request<DocTemplate>(`/doc-templates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  reorderDocTemplates: (ids: string[]) => request<DocTemplate[]>(`/doc-templates/order`, { method: "PUT", body: JSON.stringify({ ids }) }),
  deleteDocTemplate: (id: string) => request<{ id: string }>(`/doc-templates/${id}`, { method: "DELETE" }),
  applyDocStarterKit: (projectId: string, templateIds?: string[]) =>
    request<string[]>(`/doc-templates/apply/${projectId}`, { method: "POST", body: JSON.stringify({ templateIds }) }),
  /** Row 67: branding + PDF export. */
  /** Row 80: Google Workspace SSO. */
  getSso: () => request<{ ssoDomain: string | null; googleProviderHint: string }>(`/auth/sso`),
  updateSso: (ssoDomain: string | null) =>
    request<{ ssoDomain: string | null; googleProviderHint: string }>(`/auth/sso`, { method: "PATCH", body: JSON.stringify({ ssoDomain }) }),
  /** Row 107 */
  getPriorities: () => request<Partial<Record<Priority, { label: string; color: string }>>>(`/branding/priorities`),
  updatePriorities: (body: Partial<Record<Priority, { label: string; color: string }>>) =>
    request<Partial<Record<Priority, { label: string; color: string }>>>(`/branding/priorities`, { method: "PATCH", body: JSON.stringify(body) }),
  getBranding: () => request<Branding>(`/branding`),
  updateBranding: (body: Partial<Omit<Branding, "name"> & { name: string }>) =>
    request<Branding>(`/branding`, { method: "PATCH", body: JSON.stringify(body) }),
  /** Fetches an authenticated PDF and opens it in a new tab. */
  openDocPdf: async (docId: string) => {
    const token = await accessToken();
    const res = await fetch(`${API_URL}/api/documents/${docId}/pdf`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(activeOrgId ? { "x-org-id": activeOrgId } : {}) },
    });
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  publicDocPdfUrl: (token: string) => `${API_URL}/api/public/docs/${token}/pdf`,
  /** Row 66: snippets. */
  getSnippets: () => request<Snippet[]>(`/snippets`),
  getSnippet: (id: string) => request<Snippet>(`/snippets/${id}`),
  createSnippet: (body: { name: string; content?: Record<string, unknown> | null; body?: string }) =>
    request<Snippet>(`/snippets`, { method: "POST", body: JSON.stringify(body) }),
  updateSnippet: (id: string, body: Partial<{ name: string; content: Record<string, unknown> | null; body: string }>) =>
    request<Snippet>(`/snippets/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSnippet: (id: string) => request<{ id: string }>(`/snippets/${id}`, { method: "DELETE" }),
  /** Row 65: share link + public read. */
  enableDocShare: (docId: string) => request<Doc>(`/documents/${docId}/share`, { method: "POST" }),
  disableDocShare: (docId: string) => request<Doc>(`/documents/${docId}/share`, { method: "DELETE" }),
  getPublicDoc: (token: string) =>
    publicRequest<{ title: string; icon: string | null; settings: DocSettings; content: Record<string, unknown> | null; body: string; updatedAt: string; project: string | null; organization: string | null; reviewStatus: DocReviewStatus }>(`/public/docs/${token}`),
  /** Row 63: review & sign-off. */
  requestDocReview: (docId: string, body: { approverId: string; note?: string }) =>
    request<Doc>(`/documents/${docId}/review`, { method: "POST", body: JSON.stringify(body) }),
  decideDocReview: (docId: string, body: { approve: boolean; note?: string }) =>
    request<Doc>(`/documents/${docId}/review/decision`, { method: "POST", body: JSON.stringify(body) }),
  /** Row 62: who can open the doc. */
  setDocAccess: (docId: string, body: { access: DocAccess; userIds?: string[]; roles?: string[] }) =>
    request<Doc>(`/documents/${docId}/access`, { method: "PATCH", body: JSON.stringify(body) }),
  /** Row 61: attach / detach a doc from a record. */
  addDocLink: (docId: string, body: { entityType: DocLinkEntity; entityId: string }) =>
    request<Doc>(`/documents/${docId}/links`, { method: "POST", body: JSON.stringify(body) }),
  removeDocLink: (docId: string, linkId: string) => request<Doc>(`/documents/${docId}/links/${linkId}`, { method: "DELETE" }),
};

export interface ChatMember {
  id: string;
  name: string;
  avatarUrl: string | null;
}
export type ChannelNotify = "all" | "mentions" | "muted";
export interface ChannelBookmark {
  id: string;
  label: string;
  url: string;
}

export interface ChatChannel {
  id: string;
  type: "channel" | "dm";
  name: string | null;
  topic: string | null;
  /** Row 42: other people's messages since my last-read mark. */
  unreadCount: number;
  lastReadAt: string | null;
  /** Row 45: my notification rule for this channel. */
  notify: ChannelNotify;
  /** Row 46: header links. */
  bookmarks: ChannelBookmark[];
  /** Row 50: project channels post task/stage/milestone/doc events. */
  activityFeed: boolean;
  /** Invite-only (row 39). Project channels are always private. */
  isPrivate: boolean;
  projectId: string | null;
  project: { id: string; name: string; color: string; archived: boolean } | null;
  members: ChatMember[];
}

/** Row 39: someone on a project team. */
export type ProjectRole = "lead" | "contributor" | "viewer";
export interface ProjectMember {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  isLead: boolean;
  isCreator: boolean;
  /** Row 85 */
  role: ProjectRole;
}
export interface ChatMessage {
  id: string;
  channelId: string;
  body: string;
  createdAt: string;
  author: ChatMember;
  /** Row 40: set on replies; null for channel-level messages. */
  parentMessageId: string | null;
  replyCount?: number;
  lastReplyAt?: string | null;
  /** Row 43: files sent with the message. */
  attachments?: Attachment[];
  /** Row 44: grouped emoji reactions. */
  reactions?: ReactionGroup[];
  /** Row 46: when it was pinned, or null. */
  pinnedAt?: string | null;
  /** Row 50: system lines carry the actor as author and an event in meta. */
  kind?: "user" | "system";
  meta?: { type: string; link?: string; entityId?: string } | null;
  /** Row 47: the task created from this message. */
  task?: { id: string; title: string; reference: string | null; status: { name: string; color: string; category: string } | null } | null;
}
