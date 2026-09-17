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
  /** The server's human message when the body was Nest's `{ message }` JSON, else the raw text. */
  readonly detail: string;
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.detail = ApiError.extract(message);
  }
  private static extract(message: string) {
    const raw = message.replace(/^API \d+: /, "");
    try {
      const j = JSON.parse(raw) as { message?: string | string[] };
      if (Array.isArray(j.message)) return j.message.join(", ");
      if (typeof j.message === "string") return j.message;
    } catch {
      /* not JSON */
    }
    return raw;
  }
}
/** Message to show a person for any thrown value. */
export function errorMessage(e: unknown, fallback = "Something went wrong") {
  if (e instanceof ApiError) return e.detail || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
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
  /** Row 119 */
  clientVisible: boolean;
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
  /** Row 119 */
  clientVisible?: boolean;
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
  /** Row 119 */
  clientVisible?: boolean;
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
  /** Row 155: the automation rule that made this change, if any. */
  rule?: { id: string; name: string } | null;
}

// ---- Rows 153-155: automations ----
export interface AutomationTrigger {
  type: "task_created" | "task_status_changed" | "task_completed" | "expense_approved" | "invoice_overdue" | "invoice_paid" | "stage_completed" | "milestone_reached" | "deal_stage_changed";
  toName?: string | null;
}
export type AutomationAction =
  | { type: "notify"; to: "admins" | "project_lead" | "assignees" | "rule_owner" | "user"; userId?: string | null; message: string }
  | { type: "assign"; userId: string }
  | { type: "move"; statusName: string }
  | { type: "create_task"; title: string; assigneeId?: string | null; dueInDays?: number | null; listId?: string | null };
export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  owner: { id: string; name: string };
  project: { id: string; name: string } | null;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  runs: number;
  failures: number;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
}
export interface AutomationRun {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  status: "ok" | "failed";
  summary: string[];
  error: string | null;
  createdAt: string;
}
export interface AutomationTrail {
  id: string;
  rule: { id: string; name: string } | null;
  status: "ok" | "failed";
  summary: string[];
  error: string | null;
  createdAt: string;
}
/** Row 154 */
export interface InvoiceReminders {
  enabled: boolean;
  days: number[];
  paused: boolean;
  to: string | null;
  daysOverdue: number;
  nextStep: number | null;
  nextAt: string | null;
  mailConfigured: boolean;
  sent: { id: string; step: number; sentTo: string; subject: string; delivered: boolean; sentAt: string; manual: boolean }[];
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

/** Row 118: what a client sees. */
export interface PortalProject {
  organization: { name: string; brandColor: string; brandLogoUrl: string | null; brandFooter: string | null };
  project: { id: string; name: string; color: string; status: string; client: string | null; lead: string | null; startDate: string | null; endDate: string | null; description: string | null };
  stages: { id: string; index: number; name: string; status: "not_started" | "active" | "completed"; progressPct: number; startedAt: string | null; completedAt: string | null }[];
  stageSummary: { total: number; completed: number; current: string | null };
  milestones: { id: string; name: string; description: string | null; targetDate: string | null; reachedAt: string | null; signoffStatus: string | null; signoffNote: string | null; signoffBy: string | null; openTasks: number; clientApprovedAt?: string | null; clientApprovedBy?: string | null; clientApprovalNote?: string | null; clientDecision?: "approved" | "changes_requested" | null }[];
  tasks: { id: string; reference: string | null; title: string; status: string | null; statusCategory: string | null; statusColor: string | null; dueDate: string | null; completedAt: string | null }[];
  docs: { id: string; title: string; icon: string | null; updatedAt: string; reviewStatus: string; shareToken: string | null; clientApprovedAt?: string | null; clientApprovedBy?: string | null; clientDecision?: "approved" | "changes_requested" | null }[];
  generatedAt: string;
  invoices?: PortalInvoice[];
  balances?: PortalBalance[];
}
/** Row 126 */
export interface ClickUpPreview {
  importId: string;
  filename: string;
  totalRows: number;
  subtasks: number;
  alreadyImported: number;
  columns: string[];
  lists: { key: string; space: string; folder: string; list: string; count: number; already: number; sample: string[]; statuses: { name: string; count: number }[]; suggestedListId: string | null; suggestedSpaceId: string | null }[];
  assignees: { label: string; count: number; userId: string | null }[];
  tags: { name: string; count: number }[];
  spaces: { id: string; name: string }[];
  existingLists: { id: string; name: string; spaceId: string }[];
  members: { id: string; name: string }[];
}
export interface ClickUpListMapping {
  listId?: string;
  createIn?: { spaceId?: string; newSpaceName?: string; listName: string };
  statuses?: Record<string, string>;
}
export interface ClickUpResult {
  created: number;
  skipped: number;
  subtasks: number;
  assigned: number;
  tagged: number;
  unmappedLists: string[];
  errors: string[];
}

/** Row 125 */
export type TrashType = "task" | "document" | "project";
export interface TrashItem {
  type: TrashType;
  id: string;
  title: string;
  context: string | null;
  deletedAt: string;
  deletedBy: string | null;
  expiresAt: string;
  daysLeft: number;
}

/** Row 21 */
export interface DocVersion {
  id: string;
  documentId: string;
  title: string;
  reason: "auto" | "manual" | "restore";
  label: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  words: number;
  content?: Record<string, unknown> | null;
  body?: string;
}

/** Row 16 */
export interface DocComment {
  id: string;
  documentId: string;
  parentId: string | null;
  quote: string | null;
  body: string;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}
export interface DocThread extends DocComment {
  replies: DocComment[];
}

/** Row 124 */
export type LinkedEntity = "task" | "document" | "project" | "contact" | "company";
export interface LinkedFile {
  id: string;
  entityType: LinkedEntity;
  entityId: string;
  provider: "google_drive" | "dropbox" | "link";
  url: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  iconUrl: string | null;
  lastModifiedAt: string | null;
  lastCheckedAt: string | null;
  addedBy: { id: string; name: string } | null;
  createdAt: string;
}

/** Row 123 */
export interface SearchHit {
  id: string;
  title: string;
  subtitle: string;
  color?: string | null;
  nav: { kind: "task" | "project" | "document" | "company" | "contacts" | "channel"; id?: string; messageId?: string };
}
export interface SearchResult {
  q: string;
  total?: number;
  groups: { type: string; label: string; items: SearchHit[] }[];
}

/** Row 120 */
export interface PortalAccess {
  id: string;
  email: string;
  name: string | null;
  contactId: string | null;
  projectIds: string[];
  status: "active" | "expired" | "revoked";
  expiresAt: string | null;
  revokedAt: string | null;
  invitedBy: { id: string; name: string } | null;
  lastSentAt: string | null;
  lastOpenedAt: string | null;
  createdAt: string;
  link: string;
}
/** Row 122 */
export interface PortalEvent {
  id: string;
  kind: "opened" | "viewed_doc" | "approved" | "changes_requested" | string;
  who: string;
  entityType: string | null;
  entityId: string | null;
  label: string | null;
  note: string | null;
  createdAt: string;
}
export interface PortalHome {
  guest: { name: string | null; email: string; expiresAt: string | null };
  organization: { name: string; brandColor: string; brandLogoUrl: string | null; brandFooter: string | null } | null;
  projects: { id: string; name: string; color: string; status: string }[];
  invoices?: PortalInvoice[];
  balances?: PortalBalance[];
}
export interface PortalDoc {
  id: string;
  title: string;
  icon: string | null;
  settings: DocSettings;
  content: Record<string, unknown> | null;
  body: string;
  updatedAt: string;
  reviewStatus: string;
}

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
  /** Row 119 */
  clientVisible: boolean;
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
  /** Row 121 */
  clientDecision?: "approved" | "changes_requested" | null;
  clientDecidedAt?: string | null;
  clientDecidedBy?: string | null;
  clientDecisionNote?: string | null;
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
  /** Row 137: fixed fee for the stage. */
  feeAmount: number | null;
  /** Row 150 */
  budgetHours: number | null;
  budgetAmount: number | null;
}
/** Rows 150-152 */
export interface StageBurn {
  id: string;
  index: number;
  name: string;
  status: StageStatus;
  progressPct: number;
  feeAmount: number | null;
  budgetHours: number | null;
  budgetAmount: number | null;
  usedHours: number;
  usedCost: number;
  hoursPct: number | null;
  costPct: number | null;
  remainingHours: number | null;
  remainingAmount: number | null;
  atRisk: boolean;
  overBudget: boolean;
  alerts: string[];
}
export interface StageBurnReport {
  project: { id: string; name: string; currency: string };
  stages: StageBurn[];
  totals: { budgetHours: number; usedHours: number; budgetAmount: number; usedCost: number };
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
  kind: "doc_review" | "milestone" | "timesheet" | "leave" | "expense" | "invoice_review" | "invoice_issue";
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
/** Row 111 */
export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  weekends: boolean;
  timezone: string;
}
export interface NotificationPreferences {
  channels: Record<NotifType, ChannelPrefs>;
  digest: DigestPrefs;
  /** False when the server has no mail provider - email switches still save, but nothing goes out. */
  emailConfigured: boolean;
  /** Row 111: personal override; null = follow the workspace window. */
  quietHours: QuietHours | null;
  workspaceQuietHours: QuietHours;
}
export interface WorkspaceNotificationDefaults {
  channels: Record<NotifType, ChannelPrefs>;
  quietHours: QuietHours;
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
  /** Row 88: the person's weekly capacity, for "29/40". Row 110: after holidays on their working days. */
  expectedHours: number;
  holidays?: { date: string; name: string; kind: string }[];
  workingDays?: number[];
}

/** Row 115 */
export interface AuditEntry extends ActivityEntry {
  entityType: string;
  entityId: string;
  label: string | null;
}
export interface AuditPage {
  entries: AuditEntry[];
  nextCursor: string | null;
}

/** Row 114 */
export type CustomFieldEntity = "task" | "project" | "contact";
export type CustomFieldType = "text" | "number" | "date" | "select" | "checkbox" | "url" | "user";
export interface CustomFieldDef {
  id: string;
  entityType: CustomFieldEntity;
  name: string;
  type: CustomFieldType;
  options: string[] | null;
  required: boolean;
  position: number;
}
export interface CustomFieldWithValue {
  id: string;
  name: string;
  type: CustomFieldType;
  options: string[] | null;
  required: boolean;
  value: unknown;
}
export interface CustomFieldValues {
  fields: CustomFieldWithValue[];
  users: Record<string, string>;
}

/** Row 112 */
export type IntegrationProvider = "google_drive" | "dropbox" | "quickbooks" | "xero";
export interface IntegrationStatus {
  provider: IntegrationProvider;
  label: string;
  configured: boolean;
  requiredEnv: string[];
  status: "connected" | "needs_reconnect" | "failing" | "disconnected";
  accountEmail: string | null;
  accountName: string | null;
  connectedBy: { id: string; name: string } | null;
  /** Row 131: QuickBooks realmId / Xero tenantId. */
  externalId?: string | null;
  kind?: "files" | "accounting";
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

// ---- Row 131: accounting sync ----
export type AccountingProviderKey = "quickbooks" | "xero" | "demo";
export interface AccountingSettings {
  provider: AccountingProviderKey | null;
  autoSync: boolean;
  syncPayments: boolean;
  xeroSalesAccountCode: string;
  xeroPaymentAccountCode: string;
  quickbooksItemName: string;
}
export type AccountingLinkStatus = "synced" | "drifted" | "conflict" | "error";
export interface AccountingLink {
  id: string;
  provider: string;
  entityType: "company" | "invoice" | "payment";
  entityId: string;
  remoteId: string;
  remoteLabel: string | null;
  remoteUrl: string | null;
  status: AccountingLinkStatus;
  error: string | null;
  conflict: { ours: Record<string, unknown>; theirs: Record<string, unknown>; detectedAt: string; reason: string } | null;
  syncedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
  invoice: { id: string; number: string; title: string; status: InvoiceStatus; total: number } | null;
}
export interface AccountingRun {
  id: string;
  provider: string;
  trigger: "manual" | "auto";
  startedAt: string;
  finishedAt: string | null;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  errors: number;
  message: string | null;
  startedBy: { id: string; name: string } | null;
}
export interface AccountingOverview {
  settings: AccountingSettings;
  providers: IntegrationStatus[];
  counts: { synced: number; drifted: number; conflicts: number; errors: number; pending: number };
  attention: AccountingLink[];
  links: AccountingLink[];
  runs: AccountingRun[];
  running: boolean;
}
export interface AccountingSyncResult {
  runId: string;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  errors: number;
  message: string | null;
}
export interface InvoiceAccounting {
  provider: AccountingProviderKey;
  status: AccountingLinkStatus | "pending";
  remoteId: string | null;
  remoteLabel: string | null;
  remoteUrl: string | null;
  syncedAt: string | null;
  error: string | null;
  linkId: string | null;
}
export interface AccountingDemoRecord {
  remoteId: string;
  kind: "customer" | "invoice" | "payment";
  version: number;
  updatedAt: string;
  data: Record<string, unknown>;
}

/** Row 116 */
export interface ServiceHealth {
  id: "email" | "payments" | "calendar" | "esign";
  label: string;
  status: "connected" | "failing" | "not_set_up";
  detail: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  canCheck: boolean;
}
export interface IntegrationHealth {
  providers: IntegrationStatus[];
  services: ServiceHealth[];
}

/** Row 110 */
export type EmploymentType = "full_time" | "part_time" | "contractor";
export interface WorkCalendar {
  standardWeeklyHours: number;
  workingDays: number[];
  holidays: { id: string; date: string; name: string; kind: "holiday" | "closure" }[];
  members: { userId: string; name: string; avatarUrl: string | null; role: string; weeklyCapacityHours: number; workingDays: number[] | null; employmentType: EmploymentType }[];
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
  /** Row 147: capacity − holidays − approved leave for that week. */
  available: number;
  logged: number;
  utilization: number;
  /** Row 148: planned past what the person has. */
  over: boolean;
  byProject: Record<string, number>;
  /** projectId → stageId ('' = no stage) → hours */
  byStage: Record<string, Record<string, number>>;
  loggedByProject: Record<string, number>;
  loggedByStage: Record<string, Record<string, number>>;
}

export interface PlanVsLogged {
  project: { id: string; name: string; color: string };
  weeks: string[];
  rows: { userId: string; name: string; stageId: string; stage: string; planned: number; logged: number; weeks: { weekStart: string; planned: number; logged: number }[] }[];
  byStage: { id: string; name: string; planned: number; logged: number }[];
}

export interface ResourcingBoard {
  weeks: string[];
  projects: { id: string; name: string; color: string; stages: { id: string; name: string; status: StageStatus }[] }[];
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

// ---- Finance: invoices (row 156) ----
export type InvoiceStatus = "draft" | "review" | "sent" | "viewed" | "partially_paid" | "paid" | "void" | "superseded";
/** Row 139 */
export interface InvoicingSettings {
  prefix: string;
  padding: number;
  nextNumber: number | null;
  defaultDueDays: number;
  defaultTaxRate: number;
  defaultCurrency: string;
  defaultNotes: string;
  requireReview: boolean;
  /** Row 154 */
  reminderDays?: number[];
  remindersEnabled?: boolean;
  reminderNote?: string;
}
export interface InvoiceVersion {
  id: string;
  version: number;
  status: InvoiceStatus;
  total: number;
  issueDate: string;
  sentAt: string | null;
  revisionReason: string | null;
  createdAt: string;
  current: boolean;
}
export type PaymentMethod = "bank_transfer" | "card" | "cash" | "cheque" | "other";

export interface InvoiceItem {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount?: number;
  /** Row 137 */
  stageId?: string | null;
  billedPct?: number | null;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  method: PaymentMethod;
  paidAt: string;
  reference: string | null;
  note: string | null;
  /** Row 129: "stripe" when the client paid through the link. */
  provider: "stripe" | null;
  recordedBy: { id: string; name: string } | null;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  title: string;
  status: InvoiceStatus;
  /** Open and past its due date — derived, not a stored status. */
  overdue: boolean;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  notes: string | null;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  token: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  paidAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  estimateId: string | null;
  proposalId: string | null;
  dealId: string | null;
  createdAt: string;
  updatedAt: string;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string | null } | null;
  project: { id: string; name: string } | null;
  /** Row 157: the billing schedule that generated this invoice, if any. */
  schedule: { id: string; name: string; nextRunAt: string | null; status: ScheduleStatus } | null;
}

export interface Invoice extends InvoiceSummary {
  /** Row 129: show "Pay now" on the client link. */
  onlinePayments: boolean;
  /** Row 139 */
  version: number;
  revisionOfId: string | null;
  supersededById: string | null;
  revisionReason: string | null;
  submittedForReviewAt: string | null;
  submittedById: string | null;
  issuedById: string | null;
  deal: { id: string; title: string } | null;
  createdBy: { id: string; name: string } | null;
  items: Required<InvoiceItem>[];
  payments: InvoicePayment[];
}

export interface InvoiceInput {
  title?: string;
  companyId?: string | null;
  contactId?: string | null;
  projectId?: string | null;
  dealId?: string | null;
  currency?: string;
  issueDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  taxRate?: number;
  discountPercent?: number;
  items?: InvoiceItem[];
}

export interface InvoiceTotals {
  outstanding: number;
  overdue: number;
  overdueCount: number;
  paidLast30: number;
  drafts: number;
  inReview: number;
  openCount: number;
}

export interface PublicInvoice {
  token: string;
  invoice: {
    number: string;
    version: number;
    superseded: boolean;
    title: string;
    status: InvoiceStatus;
    overdue: boolean;
    currency: string;
    issueDate: string;
    dueDate: string | null;
    notes: string | null;
    items: Required<InvoiceItem>[];
    subtotal: number;
    discountPercent: number;
    discountAmount: number;
    taxRate: number;
    taxAmount: number;
    total: number;
    amountPaid: number;
    balanceDue: number;
    paidAt: string | null;
    billTo: { company: string | null; contact: string | null; email: string | null; address: string | null };
    project: string | null;
    payments: { amount: number; method: PaymentMethod; paidAt: string; provider: "stripe" | null }[];
    /** Row 129: Stripe keys present, invoice allows it, balance outstanding. */
    payOnline: boolean;
  };
  from: { name: string; color: string; logoUrl: string | null; footer: string | null };
}

/** Row 129: what the client portal shows about money. */
export interface PortalInvoice {
  id: string;
  number: string;
  title: string;
  status: InvoiceStatus;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  paidAt: string | null;
  total: number;
  amountPaid: number;
  balanceDue: number;
  overdue: boolean;
  token: string | null;
  projectId: string | null;
}
export interface PortalBalance {
  currency: string;
  outstanding: number;
  overdue: number;
}

// ---- Finance: recurring & subscription invoices (row 157) ----
export type ScheduleKind = "recurring" | "subscription";
export type ScheduleUnit = "week" | "month" | "year";
export type ScheduleStatus = "active" | "paused" | "ended";
export type ScheduleFrequency = "weekly" | "monthly" | "quarterly" | "yearly" | "custom";

export interface InvoiceSchedule {
  id: string;
  name: string;
  kind: ScheduleKind;
  status: ScheduleStatus;
  title: string;
  currency: string;
  items: InvoiceItem[];
  taxRate: number;
  discountPercent: number;
  notes: string | null;
  dueDays: number;
  autoSend: boolean;
  /** Row 138 */
  reviewerId: string | null;
  reviewer: { id: string; name: string } | null;
  reviewNudgeDays: number;
  every: number;
  unit: ScheduleUnit;
  frequency: ScheduleFrequency;
  anchorDay: number | null;
  startsAt: string;
  nextRunAt: string | null;
  endsAt: string | null;
  maxOccurrences: number | null;
  occurrences: number;
  lastRunAt: string | null;
  lastInvoiceId: string | null;
  lastError: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Total of one generated invoice, from the template lines. */
  amount: number;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
}

export interface InvoiceScheduleDetail extends InvoiceSchedule {
  createdBy: { id: string; name: string } | null;
  invoices: InvoiceSummary[];
}

export interface InvoiceScheduleInput {
  name?: string;
  kind?: ScheduleKind;
  title?: string;
  companyId?: string | null;
  contactId?: string | null;
  projectId?: string | null;
  currency?: string;
  items?: InvoiceItem[];
  taxRate?: number;
  discountPercent?: number;
  notes?: string | null;
  dueDays?: number;
  autoSend?: boolean;
  reviewerId?: string | null;
  reviewNudgeDays?: number;
  every?: number;
  unit?: ScheduleUnit;
  startsAt?: string;
  endsAt?: string | null;
  maxOccurrences?: number | null;
}

export interface ScheduleTotals {
  active: number;
  nextRunAt: string | null;
  generated: number;
}

// ---- CRM: contracts with e-signature (rows 158-159) ----
export type ContractKind = "service_agreement" | "nda" | "retainer" | "contractor" | "custom";
export type ContractStatus = "draft" | "sent" | "viewed" | "signed" | "declined" | "expired";
export type SignatureType = "typed" | "drawn";

export interface ContractFields {
  fee?: number | null;
  currency?: string;
  startDate?: string | null;
  endDate?: string | null;
  custom?: Record<string, string>;
}

export interface ContractTemplate {
  id: string;
  name: string;
  kind: ContractKind;
  description: string | null;
  sections: ProposalSection[];
  isDefault: boolean;
}

export interface ContractSigner {
  id: string;
  role: "client" | "company";
  name: string;
  email: string | null;
  contactId: string | null;
  userId: string | null;
  token: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  signedAt: string | null;
  signatureType: SignatureType | null;
  signatureName: string | null;
  signatureTitle: string | null;
  signatureImage: string | null;
  signatureIp: string | null;
  declinedAt: string | null;
  declineReason: string | null;
}

export interface ContractSummary {
  id: string;
  number: string;
  title: string;
  kind: ContractKind;
  kindLabel: string;
  status: ContractStatus;
  fields: ContractFields;
  validUntil: string | null;
  requireCountersign: boolean;
  sentAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  expiredAt: string | null;
  pdfKey: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string | null } | null;
  deal: { id: string; title: string } | null;
  project: { id: string; name: string } | null;
  signers: ContractSigner[];
}

export interface ContractEvent {
  id: string;
  kind: string;
  detail: string | null;
  at: string;
  ip: string | null;
  actor: { id: string; name: string } | null;
  signer: { id: string; name: string; role: "client" | "company" } | null;
}

export interface Contract extends ContractSummary {
  sections: ProposalSection[];
  rendered: ProposalSection[] | null;
  createdBy: { id: string; name: string } | null;
  events: ContractEvent[];
  pdfUrl: string | null;
  placeholders: readonly (readonly [string, string])[];
}

export interface ContractInput {
  title?: string;
  kind?: ContractKind;
  sections?: ProposalSection[];
  fields?: ContractFields;
  validUntil?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  projectId?: string | null;
  requireCountersign?: boolean;
  signers?: { id?: string; contactId?: string | null; name?: string; email?: string | null }[];
}

export interface SignaturePayload {
  signatureType: SignatureType;
  name: string;
  title?: string;
  image?: string | null;
  agreed: boolean;
}

export interface PublicContract {
  token: string;
  signer: { id: string; name: string; email: string | null; signedAt: string | null; signatureType: SignatureType | null; signatureName: string | null; signatureTitle: string | null; signatureImage: string | null; declinedAt: string | null };
  contract: {
    number: string;
    title: string;
    kind: ContractKind;
    kindLabel: string;
    status: ContractStatus;
    sentAt: string | null;
    signedAt: string | null;
    validUntil: string | null;
    expired: boolean;
    company: string | null;
    sections: ProposalSection[];
    parties: { role: "client" | "company"; name: string; title: string | null; signedAt: string | null; signatureType: SignatureType | null; signatureImage: string | null; me: boolean }[];
    pdfUrl: string;
  };
  from: { name: string; color: string; logoUrl: string | null; footer: string | null };
}

// ---- Finance: expenses (row 160) ----
export type ExpenseKind = "expense" | "refund";
export interface Expense {
  id: string;
  date: string;
  vendor: string;
  description: string | null;
  amount: number;
  currency: string;
  kind: ExpenseKind;
  category: string | null;
  projectId: string | null;
  companyId: string | null;
  billable: boolean;
  invoiceId: string | null;
  personal: boolean;
  receiptUrl: string | null;
  /** Row 132 */
  createdBy?: { id: string; name: string } | null;
  /** Row 133 */
  approvalStatus: "pending" | "approved" | "rejected";
  submittedAt: string | null;
  decidedAt: string | null;
  decidedBy: { id: string; name: string } | null;
  decisionNote: string | null;
  adjustsExpenseId: string | null;
  /** Row 134: per-expense override (null = category default). */
  markupPct: number | null;
  markupNote: string | null;
  /** Row 135 */
  contractorId: string | null;
  contractorInvoiceRef: string | null;
  dueDate: string | null;
  paidAt: string | null;
  paidReference: string | null;
  adjustments?: { id: string; amount: number; kind: "expense" | "refund"; description: string | null; createdAt: string }[];
  notes: string | null;
  source: "manual" | "import";
  importId: string | null;
  account: string | null;
  reference: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  invoice: { id: string; number: string } | null;
}
export interface ExpenseInput {
  date?: string;
  vendor?: string;
  description?: string | null;
  amount?: number;
  currency?: string;
  kind?: ExpenseKind;
  category?: string | null;
  projectId?: string | null;
  companyId?: string | null;
  billable?: boolean;
  personal?: boolean;
  receiptUrl?: string | null;
  notes?: string | null;
  account?: string | null;
  reference?: string | null;
}
export interface ExpenseTotals {
  thisMonth: number;
  uncategorised: number;
  unbilledBillable: number;
  unbilledCount: number;
  personalThisMonth: number;
  pendingCount: number;
  pendingAmount: number;
}
/** Row 134 */
export interface ExpenseCategory {
  name: string;
  markupPct: number;
  active: boolean;
}
// ---- Row 135: freelancers ----
export interface Contractor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  defaultRate: number | null;
  currency: string;
  notes: string | null;
  active: boolean;
  createdAt: string;
  invoiced: number;
  unpaid: number;
  invoiceCount: number;
  projectCount: number;
}
export interface ContractorInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  role?: string | null;
  defaultRate?: number | null;
  currency?: string;
  notes?: string | null;
  active?: boolean;
}
export interface ContractorEngagement {
  id: string;
  projectId: string;
  contractorId: string;
  role: string | null;
  agreedAmount: number | null;
  agreedRate: number | null;
  markupPct: number | null;
  notes: string | null;
  createdAt: string;
  project?: { id: string; name: string; color: string; status: string };
}
export interface ContractorInvoice {
  id: string;
  contractorId: string | null;
  contractor: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  projectId: string | null;
  ref: string | null;
  description: string | null;
  amount: number;
  currency: string;
  kind: "expense" | "refund";
  date: string;
  dueDate: string | null;
  paidAt: string | null;
  paidReference: string | null;
  overdue: boolean;
  billable: boolean;
  personal: boolean;
  markupPct: number | null;
  approvalStatus: "pending" | "approved" | "rejected";
  receiptUrl: string | null;
  invoice: { id: string; number: string } | null;
}
export interface ContractorDetail extends Omit<Contractor, "invoiced" | "unpaid" | "invoiceCount" | "projectCount"> {
  engagements: ContractorEngagement[];
  invoices: ContractorInvoice[];
}
export interface ProjectContractors {
  engagements: (ContractorEngagement & { contractor: Omit<Contractor, "invoiced" | "unpaid" | "invoiceCount" | "projectCount">; invoiced: number; unpaid: number; billable: number; invoices: ContractorInvoice[] })[];
  totals: { invoiced: number; unpaid: number; billable: number; pendingApproval: number; currency: string; categoryMarkupPct: number };
}
// ---- Rows 142-146: agency reports ----
export interface Utilization {
  from: string;
  to: string;
  people: { userId: string; name: string; role: string; capacity: number; holidayHours: number; leaveHours: number; available: number; loggedHours: number; billableHours: number; internalHours: number; billableUtilizationPct: number | null; loggedUtilizationPct: number | null; projects: { id: string; name: string; hours: number; billableHours: number }[] }[];
  team: { available: number; logged: number; billable: number; capacity: number; billableUtilizationPct: number | null; loggedUtilizationPct: number | null };
}
export interface Profitability {
  from: string | null;
  to: string | null;
  projects: { id: string; name: string; status: string; client: string | null; currency: string; budgetAmount: number | null; revenue: number; invoiceCount: number; collected: number; hours: number; labourCost: number; billableValue: number; expenses: number; contractorCost: number; cost: number; margin: number; marginPct: number | null; effectiveRate: number | null; missingCostRates: boolean }[];
  totals: { revenue: number; collected: number; hours: number; labourCost: number; expenses: number; cost: number; margin: number; marginPct: number | null };
}
export interface WipReport {
  onlyApproved: boolean;
  projects: UnbilledSummaryRow[];
  totals: { hours: number; hoursAmount: number; awaitingHours: number; expensesAmount: number; total: number };
}
export interface AgedReceivables {
  asOf: string;
  clients: { id: string | null; name: string; email: string | null; buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number; total: number }; invoices: { id: string; number: string; title: string; dueDate: string | null; daysOverdue: number; balance: number; currency: string; bucket: string }[] }[];
  totals: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number; total: number };
  overdue: number;
}
export interface KpiSnapshot {
  asOf: string;
  backlog: { activeProjects: number; contractedValue: number; invoicedSoFar: number; remainingValue: number; openTasks: number; overdueTasks: number };
  wip: { total: number; hours: number; awaitingHours: number; projects: number };
  receivables: { outstanding: number; overdue: number; over90: number; clients: number };
  utilization: { billablePct: number | null; loggedPct: number | null; billableHours: number; available: number; from: string };
  pipeline: { openDeals: number; value: number; weighted: number };
  profitability: { revenueYtd: number; marginYtd: number; marginPct: number | null };
}
// ---- Rows 140-141: rate cards ----
export interface RateCard {
  id: string;
  userId: string;
  effectiveFrom: string;
  billRate: number;
  costRate: number;
  currency: string;
  note: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}
export interface MemberRateCard {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  current: RateCard | null;
  upcoming: RateCard[];
  history: RateCard[];
}
export interface ProjectRates {
  project: { id: string; hourlyRate: number | null; currency: string };
  overrides: { id: string; userId: string; userName: string; effectiveFrom: string; billRate: number; note: string | null; active: boolean }[];
  effective: { userId: string; name: string; billRate: number; costRate: number; source: "project_override" | "member" | "project_default" | "none"; currency: string }[];
}
// ---- Row 137: progress billing ----
export interface ProgressBilling {
  project: { id: string; name: string; currency: string; budgetAmount: number | null };
  stages: {
    id: string;
    index: number;
    name: string;
    status: StageStatus;
    progressPct: number;
    progressSetAt: string | null;
    feeAmount: number | null;
    earned: number;
    billed: number;
    billedPct: number;
    due: number;
    overBilled: number;
    invoices: { id: string; number: string; status: InvoiceStatus; amount: number }[];
  }[];
  totals: { fee: number; earned: number; billed: number; due: number; feesMissing: number };
}
// ---- Row 136: unbilled work ----
export type UnbilledGroupBy = "person" | "task" | "single";
export interface UnbilledEntry {
  id: string;
  userId: string;
  userName: string;
  taskId: string | null;
  taskTitle: string | null;
  description: string | null;
  date: string;
  seconds: number;
  hours: number;
  rate: number;
  amount: number;
  approved: boolean;
}
export interface UnbilledWork {
  project: { id: string; name: string; currency: string; hourlyRate: number | null; companyId: string | null };
  onlyApprovedHours: boolean;
  through: string | null;
  hours: {
    seconds: number;
    hours: number;
    amount: number;
    rateMissing: boolean;
    entries: UnbilledEntry[];
    byPerson: { id: string; name: string; rate: number; seconds: number; hours: number; amount: number; count: number }[];
    byTask: { id: string | null; name: string; seconds: number; hours: number; amount: number; count: number }[];
    awaitingApproval: { count: number; seconds: number; hours: number };
  };
  expenses: { count: number; amount: number; items: BillableExpense[] };
  total: number;
}
export interface UnbilledSummaryRow {
  project: UnbilledWork["project"];
  hours: number;
  hoursAmount: number;
  awaitingHours: number;
  expensesAmount: number;
  expensesCount: number;
  total: number;
  rateMissing: boolean;
}
export interface BillableExpense extends Expense {
  effectiveMarkupPct: number;
  markupSource: "override" | "category" | "none";
  billAmount: number;
}
export interface ExpenseRule {
  id: string;
  match: string;
  category: string | null;
  projectId: string | null;
  project: { id: string; name: string } | null;
  billable: boolean | null;
  personal: boolean | null;
  hits: number;
  createdAt: string;
}
export interface ExpenseImportRow {
  line: number;
  date: string | null;
  vendor: string;
  description: string;
  amount: number;
  kind: ExpenseKind;
  currency: string | null;
  reference: string | null;
  problems: string[];
  category: string | null;
  projectId: string | null;
  billable: boolean;
  personal: boolean;
  suggestedBy: "rule" | "hint" | null;
  duplicate: boolean;
  duplicateInFile: boolean;
  skip: boolean;
}
export interface ExpenseImportPreview {
  columns: Record<"date" | "description" | "vendor" | "amount" | "debit" | "credit" | "currency" | "reference", string | null>;
  delimiter: string;
  headerless: boolean;
  total: number;
  duplicates: number;
  refunds: number;
  unreadable: number;
  rows: ExpenseImportRow[];
}
export interface ExpenseImport {
  id: string;
  filename: string;
  account: string | null;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

// ---- Finance: P&L (row 161) ----
export type PnlBasis = "cash" | "accrual";
export type PnlGranularity = "month" | "quarter" | "year";
export interface PnlReport {
  basis: PnlBasis;
  granularity: PnlGranularity;
  from: string;
  to: string;
  currency: string;
  totals: { income: number; expenses: number; net: number; margin: number | null; invoices: number; expenseCount: number };
  buckets: { key: string; label: string; income: number; expenses: number; net: number; byCategory: Record<string, number> }[];
  categories: { category: string; amount: number; share: number }[];
  vendors: { vendor: string; amount: number }[];
  clients: { id: string | null; name: string; amount: number; share: number }[];
  projects: { id: string | null; name: string; income: number; expenses: number; margin: number; marginPct: number | null }[];
}

// ---- Finance: Profit First (row 162) ----
export type ProfitBucket = "profit" | "owner_pay" | "tax" | "opex";
export interface ProfitFirstConfig {
  enabled: boolean;
  buckets: { key: ProfitBucket; label: string; currentPct: number; targetPct: number }[];
  startedAt?: string | null;
}
export interface ProfitFirstOverview {
  config: ProfitFirstConfig;
  buckets: { key: ProfitBucket; label: string; currentPct: number; targetPct: number; balance: number; allocated: number; distributed: number; untransferred: number }[];
  totals: { allocated: number; balance: number; untransferred: number };
  allocations: { id: string; date: string; income: number; source: { invoiceId: string | null; number: string | null; title: string | null; note: string | null }; lines: { id: string; bucket: ProfitBucket; pct: number | null; amount: number; transferredAt: string | null }[]; transferred: boolean }[];
  movements: { id: string; bucket: ProfitBucket; kind: "distribution" | "adjustment"; amount: number; date: string; note: string | null; createdBy: { id: string; name: string } | null }[];
  unallocated: { count: number; amount: number };
}

// ---- Finance: quarterly tax (row 163) ----
export interface TaxSettings {
  jurisdictions: { key: string; label: string; ratePct: number }[];
  basis: "net" | "income";
  deductionPct: number;
  dueDates: { q: 1 | 2 | 3 | 4; month: number; day: number }[];
  reminderDaysBefore: number;
  enabled: boolean;
}
export interface TaxQuarter {
  q: 1 | 2 | 3 | 4;
  label: string;
  from: string;
  to: string;
  dueDate: string;
  daysToDue: number;
  income: number;
  expenses: number;
  net: number;
  taxable: number;
  byJurisdiction: { key: string; label: string; ratePct: number; amount: number }[];
  estimate: number;
  paid: number;
  remaining: number;
  status: "future" | "in_progress" | "upcoming" | "due_soon" | "overdue" | "paid" | "none";
  payments: { id: string; jurisdiction: string | null; amount: number; paidAt: string; reference: string | null; note: string | null }[];
}
export interface TaxYear {
  year: number;
  settings: TaxSettings;
  quarters: TaxQuarter[];
  ytd: { income: number; expenses: number; net: number; estimate: number; paid: number; remaining: number; effectiveRatePct: number };
  projection: { net: number; estimate: number } | null;
  taxBucketBalance: number | null;
  nextDue: TaxQuarter | null;
}

// ---- Finance: billing overview + dashboard (row 164) ----
export interface CompanyBilling {
  company: { id: string; name: string };
  totals: { outstanding: number; overdue: number; overdueCount: number; openCount: number; lifetime: number; thisYear: number; invoiced: number; draftCount: number; avgDaysToPay: number | null; lastPaymentAt: string | null };
  invoices: InvoiceSummary[];
  payments: { amount: number; paidAt: string; invoiceId: string; number: string }[];
  schedules: { id: string; name: string; nextRunAt: string | null; every: number; unit: string }[];
  contracts: { id: string; number: string; title: string; status: ContractStatus; signedAt: string | null }[];
}
export interface FinanceDashboardData {
  currency: string;
  month: { income: number; expenses: number; net: number; label: string };
  ytd: { income: number; expenses: number; net: number; margin: number | null };
  receivables: { outstanding: number; overdue: number; overdueCount: number; openCount: number; drafts: number };
  expenses: { thisMonth: number; uncategorised: number; unbilledBillable: number };
  profitFirst: { buckets: { key: string; label: string; balance: number }[]; untransferred: number } | null;
  recurring: { active: number; nextRunAt: string | null };
  contractsAwaiting: number;
  nextTax: { label: string; dueDate: string; remaining: number; status: string; daysToDue: number } | null;
  recentPayments: { amount: number; paidAt: string; invoiceId: string; number: string; company: string | null }[];
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
  uploadFile: (file: File, target: { channelId?: string; taskId?: string; documentId?: string; expenseId?: string }) => {
    const form = new FormData();
    form.append("file", file, file.name);
    if (target.channelId) form.append("channelId", target.channelId);
    if (target.taskId) form.append("taskId", target.taskId);
    if (target.documentId) form.append("documentId", target.documentId);
    if (target.expenseId) form.append("expenseId", target.expenseId);
    return upload<Attachment>(`/files`, form);
  },
  getChannelFiles: (channelId: string) => request<Attachment[]>(`/files?channelId=${channelId}`),
  deleteFile: (id: string) => request<{ id: string; deleted: boolean }>(`/files/${id}`, { method: "DELETE" }),
  /** Row 2 */
  getTaskFiles: (taskId: string) => request<Attachment[]>(`/files?taskId=${taskId}`),
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
  /** Row 111 */
  getWorkspaceNotificationDefaults: () => request<WorkspaceNotificationDefaults>(`/notifications/workspace-defaults`),
  updateWorkspaceNotificationDefaults: (patch: { channels?: Partial<Record<NotifType, Partial<ChannelPrefs>>>; quietHours?: Partial<QuietHours> }) =>
    request<WorkspaceNotificationDefaults>(`/notifications/workspace-defaults`, { method: "PATCH", body: JSON.stringify(patch) }),
  updateNotificationPreferences: (patch: Partial<Record<NotifType, Partial<ChannelPrefs>>> & { digest?: Partial<DigestPrefs>; quietHours?: Partial<QuietHours> | null }) =>
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
  getStageBurn: (projectId: string) => request<StageBurnReport>(`/projects/${projectId}/stages/burn`),
  updateStage: (id: string, body: { name?: string; status?: StageStatus; note?: string; feeAmount?: number | null; budgetHours?: number | null; budgetAmount?: number | null }) =>
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
  /** Row 126 */
  previewClickUp: async (file: File) => {
    const token = await accessToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_URL}/api/import/clickup/preview`, { method: "POST", body: form, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(activeOrgId ? { "x-org-id": activeOrgId } : {}) } });
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    return (await res.json()) as ClickUpPreview;
  },
  runClickUpImport: (body: { importId: string; mapping: Record<string, ClickUpListMapping>; assignees?: Record<string, string | null> }) =>
    request<ClickUpResult>(`/import/clickup/run`, { method: "POST", body: JSON.stringify(body) }),
  /** Row 125 */
  getTrash: () => request<TrashItem[]>(`/trash`),
  restoreFromTrash: (type: TrashType, id: string) => request<{ restored: boolean }>(`/trash/${type}/${id}/restore`, { method: "POST" }),
  purgeFromTrash: (type: TrashType, id: string) => request<{ purged: boolean }>(`/trash/${type}/${id}`, { method: "DELETE" }),
  trashProject: (id: string) => request<{ id: string; trashed: boolean }>(`/projects/${id}/trash`, { method: "POST" }),
  /** Row 21 */
  getDocVersions: (docId: string) => request<DocVersion[]>(`/documents/${docId}/versions`),
  getDocVersion: (docId: string, versionId: string) => request<DocVersion>(`/documents/${docId}/versions/${versionId}`),
  saveDocVersion: (docId: string, label?: string | null) => request<DocVersion>(`/documents/${docId}/versions`, { method: "POST", body: JSON.stringify({ label: label ?? null }) }),
  restoreDocVersion: (docId: string, versionId: string) => request<{ restored: string }>(`/documents/${docId}/versions/${versionId}/restore`, { method: "POST" }),
  /** Row 16 */
  getDocComments: (docId: string) => request<DocThread[]>(`/documents/${docId}/comments`),
  createDocComment: (docId: string, body: { body: string; quote?: string | null; parentId?: string | null }) =>
    request<DocComment>(`/documents/${docId}/comments`, { method: "POST", body: JSON.stringify(body) }),
  resolveDocComment: (docId: string, commentId: string, resolved: boolean) =>
    request<DocComment>(`/documents/${docId}/comments/${commentId}/resolve`, { method: "POST", body: JSON.stringify({ resolved }) }),
  deleteDocComment: (docId: string, commentId: string) => request<{ id: string }>(`/documents/${docId}/comments/${commentId}`, { method: "DELETE" }),
  /** Row 124 */
  getLinkedFiles: (entityType: LinkedEntity, entityId: string) => request<LinkedFile[]>(`/linked-files?entityType=${entityType}&entityId=${entityId}`),
  addLinkedFile: (body: { entityType: LinkedEntity; entityId: string; url: string; name?: string | null }) => request<LinkedFile[]>(`/linked-files`, { method: "POST", body: JSON.stringify(body) }),
  refreshLinkedFile: (id: string) => request<LinkedFile[]>(`/linked-files/${id}/refresh`, { method: "POST" }),
  removeLinkedFile: (id: string) => request<LinkedFile[]>(`/linked-files/${id}`, { method: "DELETE" }),
  /** Row 123 */
  search: (q: string, limit = 8) => request<SearchResult>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  /** Row 120 */
  getPortalAccess: (projectId?: string) => request<PortalAccess[]>(`/portal/access${projectId ? `?projectId=${projectId}` : ""}`),
  createPortalAccess: (body: { email: string; name?: string | null; projectIds: string[]; expiresAt?: string | null; contactId?: string | null; send?: boolean }) =>
    request<PortalAccess>(`/portal/access`, { method: "POST", body: JSON.stringify(body) }),
  resendPortalAccess: (id: string) => request<PortalAccess>(`/portal/access/${id}/resend`, { method: "POST" }),
  revokePortalAccess: (id: string) => request<{ id: string; revoked: boolean }>(`/portal/access/${id}`, { method: "DELETE" }),
  /** Row 122 */
  getPortalEngagement: (projectId: string) => request<PortalEvent[]>(`/portal/engagement/${projectId}`),
  /** Guest side (public, token is the credential). */
  getGuestPortal: (token: string) => publicRequest<PortalHome>(`/public/portal/${token}`),
  getGuestProject: (token: string, projectId: string) => publicRequest<PortalProject>(`/public/portal/${token}/projects/${projectId}`),
  getGuestDoc: (token: string, projectId: string, docId: string) => publicRequest<PortalDoc>(`/public/portal/${token}/projects/${projectId}/docs/${docId}`),
  guestDecide: (token: string, projectId: string, body: { kind: "milestone" | "document"; id: string; decision: "approved" | "changes_requested"; note?: string }) =>
    publicRequest<{ ok: boolean; decision: string; decidedAt: string }>(`/public/portal/${token}/projects/${projectId}/decisions`, { method: "POST", body: JSON.stringify(body) }),
  /** Row 118 */
  getPortalPreview: (projectId: string) => request<PortalProject>(`/portal/preview/${projectId}`),
  getPortalPreviewDoc: (projectId: string, docId: string) => request<PortalDoc>(`/portal/preview/${projectId}/docs/${docId}`),
  /** Row 117: authenticated ZIP download (workspace or one project). */
  downloadExport: async (projectId?: string) => {
    const token = await accessToken();
    const res = await fetch(`${API_URL}/api/export/${projectId ? `projects/${projectId}` : "workspace"}`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(activeOrgId ? { "x-org-id": activeOrgId } : {}) },
    });
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export.zip";
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return name;
  },
  /** Row 115 */
  getAuditLog: (f: { q?: string; entityType?: string; actorId?: string; from?: string; to?: string; cursor?: string; limit?: number }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "" && v !== null) q.set(k, String(v));
    return request<AuditPage>(`/audit?${q.toString()}`);
  },
  /** Row 114 */
  getCustomFieldDefs: (entityType?: CustomFieldEntity) => request<CustomFieldDef[]>(`/custom-fields${entityType ? `?entityType=${entityType}` : ""}`),
  createCustomField: (body: { entityType: CustomFieldEntity; name: string; type: CustomFieldType; options?: string[]; required?: boolean }) =>
    request<CustomFieldDef>(`/custom-fields`, { method: "POST", body: JSON.stringify(body) }),
  updateCustomField: (id: string, body: { name?: string; options?: string[]; required?: boolean }) =>
    request<CustomFieldDef>(`/custom-fields/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  reorderCustomFields: (entityType: CustomFieldEntity, ids: string[]) =>
    request<CustomFieldDef[]>(`/custom-fields/reorder`, { method: "POST", body: JSON.stringify({ entityType, ids }) }),
  archiveCustomField: (id: string) => request<{ id: string }>(`/custom-fields/${id}`, { method: "DELETE" }),
  getCustomFieldValues: (entityType: CustomFieldEntity, entityId: string) => request<CustomFieldValues>(`/custom-fields/values/${entityType}/${entityId}`),
  setCustomFieldValues: (entityType: CustomFieldEntity, entityId: string, values: Record<string, unknown>) =>
    request<CustomFieldValues>(`/custom-fields/values/${entityType}/${entityId}`, { method: "PUT", body: JSON.stringify({ values }) }),
  /** Row 112 */
  getIntegrations: () => request<IntegrationStatus[]>(`/integrations`),
  /** Row 131 */
  getAccounting: () => request<AccountingOverview>(`/finance/accounting`),
  updateAccountingSettings: (body: Partial<AccountingSettings>) => request<AccountingSettings>(`/finance/accounting/settings`, { method: "PATCH", body: JSON.stringify(body) }),
  syncAccounting: (invoiceId?: string) => request<AccountingSyncResult>(`/finance/accounting/sync`, { method: "POST", body: JSON.stringify(invoiceId ? { invoiceId } : {}) }),
  resolveAccountingLink: (id: string, choice: "ours" | "theirs" | "retry") => request<AccountingOverview>(`/finance/accounting/links/${id}/resolve`, { method: "POST", body: JSON.stringify({ choice }) }),
  getInvoiceAccounting: (invoiceId: string) => request<InvoiceAccounting | null>(`/finance/accounting/invoices/${invoiceId}`),
  getAccountingDemo: () => request<AccountingDemoRecord[]>(`/finance/accounting/demo`),
  editAccountingDemo: (remoteId: string, patch: Record<string, unknown>) => request<{ id: string }>(`/finance/accounting/demo/${remoteId}/edit`, { method: "POST", body: JSON.stringify({ patch }) }),
  startIntegration: (provider: IntegrationProvider) => request<{ url: string }>(`/integrations/${provider}/start`, { method: "POST" }),
  checkIntegration: (provider: IntegrationProvider) => request<IntegrationStatus[]>(`/integrations/${provider}/check`, { method: "POST" }),
  disconnectIntegration: (provider: IntegrationProvider) => request<IntegrationStatus[]>(`/integrations/${provider}`, { method: "DELETE" }),
  /** Row 116 */
  getIntegrationHealth: () => request<IntegrationHealth>(`/integrations/health`),
  checkEmailService: () => request<IntegrationHealth>(`/integrations/email/check`, { method: "POST" }),
  /** Row 110 */
  getWorkCalendar: () => request<WorkCalendar>(`/time/calendar`),
  updateWorkCalendar: (body: { standardWeeklyHours?: number; workingDays?: number[] }) => request<WorkCalendar>(`/time/calendar`, { method: "PATCH", body: JSON.stringify(body) }),
  addHoliday: (body: { date: string; name: string; kind?: "holiday" | "closure" }) => request<WorkCalendar>(`/time/calendar/holidays`, { method: "POST", body: JSON.stringify(body) }),
  removeHoliday: (id: string) => request<WorkCalendar>(`/time/calendar/holidays/${id}`, { method: "DELETE" }),
  updateMemberCalendar: (userId: string, body: { weeklyCapacityHours?: number; workingDays?: number[] | null; employmentType?: EmploymentType }) =>
    request<WorkCalendar>(`/time/calendar/members/${userId}`, { method: "PATCH", body: JSON.stringify(body) }),
  /** Row 104 */
  getPendingTimesheets: () => request<PendingTimesheet[]>(`/time/timesheet/pending`),
  decideTimesheet: (id: string, body: { approve: boolean; note?: string }) =>
    request<TimesheetSubmission>(`/time/timesheet/submissions/${id}/decision`, { method: "POST", body: JSON.stringify(body) }),
  setTimesheetCell: (body: { projectId: string; taskId?: string | null; date: string; hours: number; userId?: string }) =>
    request<{ ok: boolean }>(`/time/timesheet`, { method: "PUT", body: JSON.stringify(body) }),
  getProjectTimeSummary: (projectId: string) =>
    request<ProjectTimeSummary>(`/time/summary/${projectId}`),

  // ---- Resourcing ----
  getPlanVsLogged: (projectId: string, from?: string, weeks = 12) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    q.set("weeks", String(weeks));
    return request<PlanVsLogged>(`/resourcing/plan-vs-logged/${projectId}?${q.toString()}`);
  },
  getResourcing: (from?: string, weeks = 12) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    q.set("weeks", String(weeks));
    return request<ResourcingBoard>(`/resourcing?${q.toString()}`);
  },
  setAllocation: (body: { userId: string; projectId: string; stageId?: string | null; weekStart: string; hours: number; note?: string }) =>
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
  /** Row 159 */
  saveProposalAsTemplate: (id: string, body: { name: string; isDefault?: boolean }) => request<ProposalTemplate>(`/crm/proposals/${id}/save-template`, { method: "POST", body: JSON.stringify(body) }),
  // public (client-facing, no auth)
  getPublicProposal: (token: string) => publicRequest<PublicProposal>(`/public/proposals/${token}`),
  acceptPublicProposal: (token: string, body: { signerName: string; signerTitle?: string; agreed: boolean }) =>
    publicRequest<PublicProposal>(`/public/proposals/${token}/accept`, { method: "POST", body: JSON.stringify(body) }),
  declinePublicProposal: (token: string, reason?: string) =>
    publicRequest<PublicProposal>(`/public/proposals/${token}/decline`, { method: "POST", body: JSON.stringify({ reason }) }),

    // ---- Finance: invoices (row 156) ----
  getInvoices: (opts: { status?: string; companyId?: string; projectId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.companyId) q.set("companyId", opts.companyId);
    if (opts.projectId) q.set("projectId", opts.projectId);
    const qs = q.toString();
    return request<InvoiceSummary[]>(`/finance/invoices${qs ? "?" + qs : ""}`);
  },
  getInvoiceTotals: () => request<InvoiceTotals>(`/finance/invoices/summary`),
  getInvoice: (id: string) => request<Invoice>(`/finance/invoices/${id}`),
  createInvoice: (body: InvoiceInput & { fromEstimateId?: string | null; fromProposalId?: string | null }) =>
    request<Invoice>(`/finance/invoices`, { method: "POST", body: JSON.stringify(body) }),
  updateInvoice: (id: string, body: InvoiceInput) => request<Invoice>(`/finance/invoices/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  sendInvoice: (id: string) => request<Invoice>(`/finance/invoices/${id}/send`, { method: "POST" }),
  reopenInvoice: (id: string) => request<Invoice>(`/finance/invoices/${id}/reopen`, { method: "POST" }),
  voidInvoice: (id: string, reason?: string) => request<Invoice>(`/finance/invoices/${id}/void`, { method: "POST", body: JSON.stringify({ reason: reason ?? null }) }),
  recordInvoicePayment: (id: string, body: { amount: number; method?: PaymentMethod; paidAt?: string | null; reference?: string | null; note?: string | null }) =>
    request<Invoice>(`/finance/invoices/${id}/payments`, { method: "POST", body: JSON.stringify(body) }),
  /** Rows 153-155 */
  getAutomationTriggers: () => request<{ type: AutomationTrigger["type"]; label: string; hasName?: string }[]>(`/automations/triggers`),
  getAutomations: () => request<AutomationRule[]>(`/automations`),
  getAutomation: (id: string) => request<AutomationRule & { runLog: AutomationRun[] }>(`/automations/${id}`),
  createAutomation: (body: { name: string; enabled?: boolean; ownerId?: string; projectId?: string | null; trigger: AutomationTrigger; actions: AutomationAction[] }) => request<AutomationRule>(`/automations`, { method: "POST", body: JSON.stringify(body) }),
  updateAutomation: (id: string, body: Partial<{ name: string; enabled: boolean; ownerId: string; projectId: string | null; trigger: AutomationTrigger; actions: AutomationAction[] }>) => request<AutomationRule>(`/automations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteAutomation: (id: string) => request<{ id: string }>(`/automations/${id}`, { method: "DELETE" }),
  getAutomationTrail: (entityType: string, entityId: string) => request<AutomationTrail[]>(`/automations/trail?entityType=${entityType}&entityId=${entityId}`),
  /** Row 154 */
  getInvoiceReminders: (id: string) => request<InvoiceReminders>(`/finance/invoices/${id}/reminders`),
  sendInvoiceReminder: (id: string) => request<InvoiceReminders>(`/finance/invoices/${id}/reminders/send`, { method: "POST" }),
  pauseInvoiceReminders: (id: string, paused: boolean) => request<InvoiceReminders>(`/finance/invoices/${id}/reminders`, { method: "PATCH", body: JSON.stringify({ paused }) }),
  /** Row 139 */
  getInvoicingSettings: () => request<InvoicingSettings>(`/finance/invoices/settings`),
  updateInvoicingSettings: (body: Partial<InvoicingSettings>) => request<InvoicingSettings>(`/finance/invoices/settings`, { method: "PATCH", body: JSON.stringify(body) }),
  getInvoiceVersions: (id: string) => request<InvoiceVersion[]>(`/finance/invoices/${id}/versions`),
  submitInvoice: (id: string) => request<Invoice>(`/finance/invoices/${id}/submit`, { method: "POST" }),
  returnInvoice: (id: string, note?: string) => request<Invoice>(`/finance/invoices/${id}/return`, { method: "POST", body: JSON.stringify({ note: note ?? null }) }),
  reviseInvoice: (id: string, reason: string) => request<Invoice>(`/finance/invoices/${id}/revise`, { method: "POST", body: JSON.stringify({ reason }) }),
  removeInvoicePayment: (id: string, paymentId: string) => request<Invoice>(`/finance/invoices/${id}/payments/${paymentId}`, { method: "DELETE" }),
  archiveInvoice: (id: string) => request<{ id: string }>(`/finance/invoices/${id}`, { method: "DELETE" }),
  /** Authenticated PDF: fetched with the bearer token and opened from a blob URL (a plain link can't carry the header). */
  openInvoicePdf: async (id: string) => {
    const token = await accessToken();
    const res = await fetch(`${API_URL}/api/finance/invoices/${id}/pdf`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(activeOrgId ? { "x-org-id": activeOrgId } : {}) },
    });
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  getPublicInvoice: (token: string) => publicRequest<PublicInvoice>(`/public/invoices/${token}`),
  publicInvoicePdfUrl: (token: string) => `${API_URL}/api/public/invoices/${token}/pdf`,
  /** Row 129 */
  startInvoiceCheckout: (token: string, amount?: number | null) =>
    publicRequest<{ url: string; sessionId: string; amount: number; currency: string }>(`/public/invoices/${token}/checkout`, { method: "POST", body: JSON.stringify({ amount: amount ?? null }) }),
  confirmInvoiceCheckout: (token: string, sessionId: string) =>
    publicRequest<{ paid: boolean; amount?: number; status?: string }>(`/public/invoices/${token}/checkout/confirm`, { method: "POST", body: JSON.stringify({ sessionId }) }),
  setInvoiceOnlinePayments: (id: string, enabled: boolean) => request<Invoice>(`/finance/invoices/${id}/online-payments`, { method: "PATCH", body: JSON.stringify({ enabled }) }),

  // ---- Finance: recurring & subscription invoices (row 157) ----
  getSchedules: (opts: { companyId?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.companyId) q.set("companyId", opts.companyId);
    if (opts.status) q.set("status", opts.status);
    const qs = q.toString();
    return request<InvoiceSchedule[]>(`/finance/schedules${qs ? "?" + qs : ""}`);
  },
  getScheduleTotals: () => request<ScheduleTotals>(`/finance/schedules/summary`),
  getSchedule: (id: string) => request<InvoiceScheduleDetail>(`/finance/schedules/${id}`),
  createSchedule: (body: InvoiceScheduleInput & { fromInvoiceId?: string | null }) =>
    request<InvoiceScheduleDetail>(`/finance/schedules`, { method: "POST", body: JSON.stringify(body) }),
  updateSchedule: (id: string, body: InvoiceScheduleInput) => request<InvoiceScheduleDetail>(`/finance/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  pauseSchedule: (id: string) => request<InvoiceScheduleDetail>(`/finance/schedules/${id}/pause`, { method: "POST" }),
  resumeSchedule: (id: string) => request<InvoiceScheduleDetail>(`/finance/schedules/${id}/resume`, { method: "POST" }),
  endSchedule: (id: string) => request<InvoiceScheduleDetail>(`/finance/schedules/${id}/end`, { method: "POST" }),
  runSchedule: (id: string) => request<InvoiceScheduleDetail>(`/finance/schedules/${id}/run`, { method: "POST" }),
  archiveSchedule: (id: string) => request<{ id: string }>(`/finance/schedules/${id}`, { method: "DELETE" }),

  // ---- CRM: contracts (rows 158-159) ----
  getContractTemplates: () => request<ContractTemplate[]>(`/crm/contract-templates`),
  createContractTemplate: (body: { name: string; kind?: ContractKind; description?: string | null; sections?: ProposalSection[]; isDefault?: boolean }) =>
    request<ContractTemplate>(`/crm/contract-templates`, { method: "POST", body: JSON.stringify(body) }),
  updateContractTemplate: (id: string, body: Partial<{ name: string; kind: ContractKind; description: string | null; sections: ProposalSection[]; isDefault: boolean }>) =>
    request<ContractTemplate>(`/crm/contract-templates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteContractTemplate: (id: string) => request<{ id: string }>(`/crm/contract-templates/${id}`, { method: "DELETE" }),
  getContracts: (opts: { companyId?: string; dealId?: string; projectId?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v) q.set(k, v);
    const qs = q.toString();
    return request<ContractSummary[]>(`/crm/contracts${qs ? "?" + qs : ""}`);
  },
  getContract: (id: string) => request<Contract>(`/crm/contracts/${id}`),
  createContract: (body: ContractInput & { templateId?: string | null }) => request<Contract>(`/crm/contracts`, { method: "POST", body: JSON.stringify(body) }),
  updateContract: (id: string, body: ContractInput) => request<Contract>(`/crm/contracts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  setContractCompanySigner: (id: string, userId: string) => request<Contract>(`/crm/contracts/${id}/company-signer`, { method: "PATCH", body: JSON.stringify({ userId }) }),
  sendContract: (id: string) => request<Contract>(`/crm/contracts/${id}/send`, { method: "POST" }),
  reopenContract: (id: string) => request<Contract>(`/crm/contracts/${id}/reopen`, { method: "POST" }),
  countersignContract: (id: string, body: SignaturePayload) => request<Contract>(`/crm/contracts/${id}/countersign`, { method: "POST", body: JSON.stringify(body) }),
  saveContractAsTemplate: (id: string, body: { name: string; kind?: ContractKind; isDefault?: boolean }) =>
    request<ContractTemplate>(`/crm/contracts/${id}/save-template`, { method: "POST", body: JSON.stringify(body) }),
  archiveContract: (id: string) => request<{ id: string }>(`/crm/contracts/${id}`, { method: "DELETE" }),
  openContractPdf: async (id: string) => {
    const token = await accessToken();
    const res = await fetch(`${API_URL}/api/crm/contracts/${id}/pdf`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(activeOrgId ? { "x-org-id": activeOrgId } : {}) },
    });
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  getPublicContract: (token: string) => publicRequest<PublicContract>(`/public/contracts/${token}`),
  signPublicContract: (token: string, body: SignaturePayload) => publicRequest<PublicContract>(`/public/contracts/${token}/sign`, { method: "POST", body: JSON.stringify(body) }),
  declinePublicContract: (token: string, reason?: string) => publicRequest<PublicContract>(`/public/contracts/${token}/decline`, { method: "POST", body: JSON.stringify({ reason }) }),

  // ---- Finance: expenses (row 160) ----
  getExpenses: (opts: { filter?: string; projectId?: string; companyId?: string; from?: string; to?: string; importId?: string; q?: string; mine?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v) q.set(k, v);
    const qs = q.toString();
    return request<Expense[]>(`/finance/expenses${qs ? "?" + qs : ""}`);
  },
  getExpenseTotals: () => request<ExpenseTotals>(`/finance/expenses/summary`),
  getExpenseCategories: () => request<string[]>(`/finance/expenses/categories`),
  getExpense: (id: string) => request<Expense>(`/finance/expenses/${id}`),
  createExpense: (body: ExpenseInput) => request<Expense>(`/finance/expenses`, { method: "POST", body: JSON.stringify(body) }),
  updateExpense: (id: string, body: ExpenseInput & { rememberVendor?: boolean; applyToSimilar?: boolean }) => request<Expense>(`/finance/expenses/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteExpense: (id: string) => request<{ id: string }>(`/finance/expenses/${id}`, { method: "DELETE" }),
  /** Row 133 */
  getExpenseQueue: () => request<Expense[]>(`/finance/expenses/queue`),
  approveExpense: (id: string, note?: string) => request<Expense>(`/finance/expenses/${id}/approve`, { method: "POST", body: JSON.stringify({ note: note ?? null }) }),
  rejectExpense: (id: string, note: string) => request<Expense>(`/finance/expenses/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) }),
  resubmitExpense: (id: string) => request<Expense>(`/finance/expenses/${id}/resubmit`, { method: "POST" }),
  adjustExpense: (id: string, body: { amount: number; note: string }) => request<Expense>(`/finance/expenses/${id}/adjust`, { method: "POST", body: JSON.stringify(body) }),
  getExpenseRules: () => request<ExpenseRule[]>(`/finance/expenses/rules`),
  createExpenseRule: (body: { match: string; category?: string | null; projectId?: string | null; billable?: boolean | null; personal?: boolean | null }) => request<ExpenseRule>(`/finance/expenses/rules`, { method: "POST", body: JSON.stringify(body) }),
  deleteExpenseRule: (id: string) => request<{ id: string }>(`/finance/expenses/rules/${id}`, { method: "DELETE" }),
  getExpenseImports: () => request<ExpenseImport[]>(`/finance/expenses/imports`),
  previewExpenseImport: (text: string) => request<ExpenseImportPreview>(`/finance/expenses/imports/preview`, { method: "POST", body: JSON.stringify({ text }) }),
  commitExpenseImport: (body: { filename: string; account?: string | null; rows: (Partial<ExpenseImportRow> & { date: string; vendor: string; amount: number })[] }) => request<ExpenseImport>(`/finance/expenses/imports`, { method: "POST", body: JSON.stringify(body) }),
  undoExpenseImport: (id: string) => request<{ id: string; removed: number }>(`/finance/expenses/imports/${id}`, { method: "DELETE" }),
  getBillableExpenses: (opts: { projectId?: string | null; companyId?: string | null }) => {
    const q = new URLSearchParams();
    if (opts.projectId) q.set("projectId", opts.projectId);
    else if (opts.companyId) q.set("companyId", opts.companyId);
    const qs = q.toString();
    return request<BillableExpense[]>(`/finance/expenses/billable${qs ? "?" + qs : ""}`);
  },
  /** markupPercent null = each expense keeps its own (override or category default). */
  addExpensesToInvoice: (invoiceId: string, expenseIds: string[], markupPercent: number | null = null) => request<Invoice>(`/finance/expenses/invoice/${invoiceId}`, { method: "POST", body: JSON.stringify({ expenseIds, markupPercent }) }),
  /** Row 138 */
  getScheduleReviewers: () => request<{ id: string; name: string; email: string | null; role: string }[]>(`/finance/schedules/reviewers`),
  getAwaitingReview: () => request<{ id: string; number: string; title: string; total: number; currency: string; createdAt: string; ageDays: number; scheduleId: string; scheduleName: string; reviewerId: string | null }[]>(`/finance/schedules/awaiting-review`),
  issueScheduledInvoice: (invoiceId: string) => request<Invoice>(`/finance/schedules/invoices/${invoiceId}/issue`, { method: "POST" }),
  /** Rows 142-146 */
  getUtilization: (from: string, to: string) => request<Utilization>(`/finance/reports/utilization?from=${from}&to=${to}`),
  getProfitability: (range?: { from: string; to: string }) => request<Profitability>(range ? `/finance/reports/profitability?from=${range.from}&to=${range.to}` : `/finance/reports/profitability?all=1`),
  getWip: (onlyApproved = true) => request<WipReport>(`/finance/reports/wip${onlyApproved ? "" : "?onlyApproved=0"}`),
  getAgedReceivables: (asOf?: string) => request<AgedReceivables>(`/finance/reports/receivables${asOf ? `?asOf=${asOf}` : ""}`),
  getKpis: () => request<KpiSnapshot>(`/finance/reports/kpis`),
  downloadReportCsv: async (report: "utilization" | "profitability" | "wip" | "receivables", opts: { from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v) q.set(k, v);
    const token = await accessToken();
    const res = await fetch(`${API_URL}/api/finance/reports/${report}.csv?${q.toString()}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(activeOrgId ? { "x-org-id": activeOrgId } : {}) } });
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${report}.csv`;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  /** Rows 140-141 */
  getRateCards: () => request<MemberRateCard[]>(`/finance/rates`),
  addRateCard: (body: { userId: string; effectiveFrom: string; billRate: number; costRate: number; currency?: string; note?: string | null }) => request<RateCard>(`/finance/rates`, { method: "POST", body: JSON.stringify(body) }),
  removeRateCard: (id: string) => request<{ id: string }>(`/finance/rates/${id}`, { method: "DELETE" }),
  getProjectRates: (projectId: string) => request<ProjectRates>(`/finance/rates/project/${projectId}`),
  addProjectRateOverride: (projectId: string, body: { userId: string; effectiveFrom: string; billRate: number; note?: string | null }) => request<{ id: string }>(`/finance/rates/project/${projectId}`, { method: "POST", body: JSON.stringify(body) }),
  removeProjectRateOverride: (projectId: string, id: string) => request<{ id: string }>(`/finance/rates/project/${projectId}/${id}`, { method: "DELETE" }),
  /** Row 137 */
  getProgressBilling: (projectId: string) => request<ProgressBilling>(`/finance/progress/${projectId}`),
  draftProgressInvoice: (body: { projectId: string; stageIds?: string[] | null; title?: string | null }) => request<Invoice>(`/finance/progress/draft`, { method: "POST", body: JSON.stringify(body) }),
  /** Row 136 */
  getUnbilled: (projectId: string, opts: { through?: string; onlyApproved?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.through) q.set("through", opts.through);
    if (opts.onlyApproved === false) q.set("onlyApproved", "0");
    const qs = q.toString();
    return request<UnbilledWork>(`/finance/unbilled/${projectId}${qs ? "?" + qs : ""}`);
  },
  getUnbilledSummary: (onlyApproved = true) => request<UnbilledSummaryRow[]>(`/finance/unbilled${onlyApproved ? "" : "?onlyApproved=0"}`),
  draftFromUnbilled: (body: { projectId: string; through?: string | null; onlyApprovedHours?: boolean; groupBy?: UnbilledGroupBy; includeExpenses?: boolean; timeEntryIds?: string[] | null; expenseIds?: string[] | null; title?: string | null }) =>
    request<Invoice>(`/finance/unbilled/draft`, { method: "POST", body: JSON.stringify(body) }),
  /** Row 135 */
  getContractors: (all = false) => request<Contractor[]>(`/finance/contractors${all ? "?all=1" : ""}`),
  getContractor: (id: string) => request<ContractorDetail>(`/finance/contractors/${id}`),
  createContractor: (body: ContractorInput) => request<ContractorDetail>(`/finance/contractors`, { method: "POST", body: JSON.stringify(body) }),
  updateContractor: (id: string, body: ContractorInput) => request<ContractorDetail>(`/finance/contractors/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveContractor: (id: string) => request<{ id: string }>(`/finance/contractors/${id}`, { method: "DELETE" }),
  getProjectContractors: (projectId: string) => request<ProjectContractors>(`/finance/contractors/project/${projectId}`),
  engageContractor: (projectId: string, body: { contractorId?: string | null; name?: string | null; email?: string | null; role?: string | null; agreedAmount?: number | null; agreedRate?: number | null; markupPct?: number | null; notes?: string | null }) =>
    request<{ id: string }>(`/finance/contractors/project/${projectId}`, { method: "POST", body: JSON.stringify(body) }),
  disengageContractor: (projectId: string, engagementId: string) => request<{ id: string }>(`/finance/contractors/project/${projectId}/${engagementId}`, { method: "DELETE" }),
  logContractorInvoice: (contractorId: string, body: { projectId: string; ref?: string | null; description?: string | null; amount: number; currency?: string; date?: string | null; dueDate?: string | null; markupPct?: number | null; billable?: boolean; receiptUrl?: string | null; paid?: boolean }) =>
    request<Expense>(`/finance/contractors/${contractorId}/invoices`, { method: "POST", body: JSON.stringify(body) }),
  markContractorInvoicePaid: (expenseId: string, body: { paid: boolean; paidAt?: string | null; reference?: string | null }) => request<Expense>(`/finance/contractors/invoices/${expenseId}/paid`, { method: "POST", body: JSON.stringify(body) }),
  /** Row 134 */
  getExpenseCategorySettings: () => request<ExpenseCategory[]>(`/finance/expenses/category-settings`),
  saveExpenseCategorySettings: (categories: ExpenseCategory[]) => request<ExpenseCategory[]>(`/finance/expenses/category-settings`, { method: "PUT", body: JSON.stringify({ categories }) }),
  setExpenseMarkup: (id: string, body: { markupPct: number | null; note?: string | null }) => request<Expense>(`/finance/expenses/${id}/markup`, { method: "PATCH", body: JSON.stringify(body) }),
  removeExpenseFromInvoice: (invoiceId: string, expenseId: string) => request<Invoice>(`/finance/expenses/invoice/${invoiceId}/${expenseId}`, { method: "DELETE" }),

  // ---- Finance: P&L (row 161) ----
  getPnl: (opts: { from?: string; to?: string; granularity?: PnlGranularity; basis?: PnlBasis } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v) q.set(k, v);
    const qs = q.toString();
    return request<PnlReport>(`/finance/reports/pnl${qs ? "?" + qs : ""}`);
  },
  downloadPnlCsv: async (opts: { from?: string; to?: string; granularity?: PnlGranularity; basis?: PnlBasis } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v) q.set(k, v);
    const token = await accessToken();
    const res = await fetch(`${API_URL}/api/finance/reports/pnl.csv?${q.toString()}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(activeOrgId ? { "x-org-id": activeOrgId } : {}) } });
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "pnl.csv";
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return name;
  },

  // ---- Finance: Profit First (row 162) ----
  getProfitFirst: () => request<ProfitFirstOverview>(`/finance/profit-first`),
  updateProfitFirst: (body: { enabled?: boolean; startedAt?: string | null; buckets?: { key: ProfitBucket; label?: string; currentPct?: number; targetPct?: number }[] }) => request<ProfitFirstConfig>(`/finance/profit-first/config`, { method: "PATCH", body: JSON.stringify(body) }),
  allocateProfitFirst: (body: { amount: number; date?: string | null; note?: string | null }) => request<ProfitFirstOverview>(`/finance/profit-first/allocate`, { method: "POST", body: JSON.stringify(body) }),
  backfillProfitFirst: () => request<ProfitFirstOverview & { allocated: number }>(`/finance/profit-first/backfill`, { method: "POST" }),
  addProfitMovement: (body: { bucket: ProfitBucket; amount: number; date?: string | null; note?: string | null; kind?: "distribution" | "adjustment"; direction?: "in" | "out" }) => request<ProfitFirstOverview>(`/finance/profit-first/movements`, { method: "POST", body: JSON.stringify(body) }),
  deleteProfitMovement: (id: string) => request<ProfitFirstOverview>(`/finance/profit-first/movements/${id}`, { method: "DELETE" }),
  setProfitAllocationTransferred: (groupId: string, transferred: boolean) => request<ProfitFirstOverview>(`/finance/profit-first/allocations/${groupId}/transferred`, { method: "PATCH", body: JSON.stringify({ transferred }) }),
  deleteProfitAllocation: (groupId: string) => request<ProfitFirstOverview>(`/finance/profit-first/allocations/${groupId}`, { method: "DELETE" }),
  transferAllProfitAllocations: () => request<ProfitFirstOverview>(`/finance/profit-first/allocations/transfer-all`, { method: "POST" }),

  // ---- Finance: quarterly tax (row 163) ----
  getTaxYear: (year?: number) => request<TaxYear>(`/finance/tax${year ? `?year=${year}` : ""}`),
  updateTaxSettings: (body: Partial<Omit<TaxSettings, "jurisdictions">> & { jurisdictions?: { key?: string; label: string; ratePct: number }[] }) => request<TaxSettings>(`/finance/tax/settings`, { method: "PATCH", body: JSON.stringify(body) }),
  recordTaxPayment: (body: { year: number; quarter: number; jurisdiction?: string | null; amount: number; paidAt?: string | null; reference?: string | null; note?: string | null }) => request<TaxYear>(`/finance/tax/payments`, { method: "POST", body: JSON.stringify(body) }),
  deleteTaxPayment: (id: string) => request<TaxYear>(`/finance/tax/payments/${id}`, { method: "DELETE" }),

  // ---- Finance: billing overview + dashboard (row 164) ----
  getCompanyBilling: (companyId: string) => request<CompanyBilling>(`/finance/companies/${companyId}/billing`),
  getFinanceDashboard: () => request<FinanceDashboardData>(`/finance/dashboard`),

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
