/**
 * Typed fetch client. Every request carries the caller's Supabase access token
 * plus the org they're acting in; the API verifies both (signature + membership)
 * before a handler runs. supabase-js refreshes the token in the background, so
 * we just read the current one per request — and retry once on a 401 in case we
 * raced a rotation.
 */
import { supabase } from "./supabase.js";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3333";

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

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
}

export interface Membership {
  organizationId: string;
  role: "owner" | "admin" | "member" | "guest";
  organization: { id: string; name: string; slug: string };
}

export type Priority = "urgent" | "high" | "normal" | "low";

export interface Member {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  /** Invited by email and has not signed in yet. */
  pending?: boolean;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface DocSummary {
  id: string;
  title: string;
  excerpt: string;
  project: { id: string; name: string } | null;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
}

export interface Doc {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  project: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  updatedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
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
  description: string | null;
  reference: string | null;
  priority: Priority | null;
  dueDate: string | null;
  statusId: string | null;
  status: Status | null;
  assignees: { user: Member }[];
  subtasks: { id: string; title?: string; status?: Status | null }[];
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

export type InboxTab = "primary" | "other" | "replies" | "later" | "cleared";

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
}

export interface UnreadCounts {
  count: number;
  primary: number;
  other: number;
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

export interface MyTask extends Task {
  list: { id: string; name: string } | null;
}

export interface NotificationPreferences {
  propertyChange: boolean;
  statusChange: boolean;
  comment: boolean;
  mention: boolean;
  taskCompleted: boolean;
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
  layout: "list" | "board" | "table";
  filters: Record<string, unknown>;
  isShared: boolean;
  createdById: string;
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
  loggedSeconds: number;
  billableSeconds: number;
}

export interface Project {
  id: string;
  spaceId: string | null;
  name: string;
  clientName: string | null;
  description: string | null;
  status: ProjectStatus;
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
  clientName?: string;
  description?: string;
  color?: string;
  status?: ProjectStatus;
  startDate?: string;
  endDate?: string;
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
}

export interface Timesheet {
  userId: string;
  weekStart: string;
  days: string[];
  rows: { projectId: string; projectName: string; color: string; hours: number[]; total: number }[];
  totals: number[];
  grandTotal: number;
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

export type DealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

export interface Deal {
  id: string;
  title: string;
  value: number;
  currency: string;
  stage: DealStage;
  probability: number;
  expectedCloseDate: string | null;
  closedAt: string | null;
  lostReason: string | null;
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
  stage?: DealStage;
  probability?: number;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
  ownerId?: string | null;
}

export interface DealColumn {
  stage: DealStage;
  count: number;
  value: number;
  weighted: number;
  deals: Deal[];
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

export interface CrmNote {
  id: string;
  entityType: NoteEntity;
  entityId: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
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
  me: () => request<{ user: AuthedUser; memberships: Membership[] }>(`/auth/me`),
  createOrganization: (name: string) =>
    request<{ id: string; name: string; slug: string; role: Membership["role"] }>(
      `/auth/organizations`,
      { method: "POST", body: JSON.stringify({ name }) },
    ),

  getSpaces: () => request<SpaceTree[]>(`/spaces`),
  getStatuses: (spaceId: string) => request<Status[]>(`/spaces/${spaceId}/statuses`),
  getMembers: () => request<Member[]>(`/members`),
  listTasks: (listId: string) =>
    request<Task[]>(`/tasks?listId=${encodeURIComponent(listId)}`),
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (body: {
    listId: string;
    title: string;
    statusId?: string;
    priority?: Priority;
  }) => request<Task>(`/tasks`, { method: "POST", body: JSON.stringify(body) }),
  updateTask: (
    id: string,
    body: Partial<{
      title: string;
      description: string;
      statusId: string;
      priority: Priority;
      dueDate: string;
    }>,
  ) => request<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
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
  sendMessage: (channelId: string, body: string) =>
    request<ChatMessage>(`/chat/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  createChannel: (name: string) =>
    request<ChatChannel>(`/chat/channels`, { method: "POST", body: JSON.stringify({ name }) }),

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
  getMyTasks: () => request<MyTask[]>(`/tasks/mine`),
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
  getNotifications: (tab: InboxTab = "primary") =>
    request<AppNotification[]>(`/notifications?tab=${tab}`),
  getUnreadCount: () => request<UnreadCounts>(`/notifications/unread-count`),
  toggleNotificationImportant: (id: string) =>
    request<AppNotification>(`/notifications/${id}/important`, { method: "PATCH" }),
  restoreNotification: (id: string) =>
    request<AppNotification>(`/notifications/${id}/restore`, { method: "PATCH" }),
  clearAllNotifications: (category?: "primary" | "other") =>
    request<{ ok: boolean }>(`/notifications/clear-all`, {
      method: "POST",
      body: JSON.stringify(category ? { category } : {}),
    }),
  markNotificationRead: (id: string) =>
    request<AppNotification>(`/notifications/${id}/read`, { method: "PATCH" }),
  markAllNotificationsRead: () =>
    request<{ ok: boolean }>(`/notifications/read-all`, { method: "POST" }),
  archiveNotification: (id: string) =>
    request<AppNotification>(`/notifications/${id}/archive`, { method: "PATCH" }),
  snoozeNotification: (id: string, until: string) =>
    request<AppNotification>(`/notifications/${id}/snooze`, {
      method: "PATCH",
      body: JSON.stringify({ until }),
    }),
  getNotificationPreferences: () =>
    request<NotificationPreferences>(`/notifications/preferences`),
  updateNotificationPreferences: (patch: Partial<NotificationPreferences>) =>
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
    listId: string;
    layout: string;
    filters: Record<string, unknown>;
    isShared?: boolean;
  }) => request<SavedView>(`/views`, { method: "POST", body: JSON.stringify(body) }),
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
  createProject: (body: ProjectInput) =>
    request<Project>(`/projects`, { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, body: Partial<ProjectInput>) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveProject: (id: string) =>
    request<{ id: string; archived: boolean }>(`/projects/${id}`, { method: "DELETE" }),

  // ---- Time tracking ----
  getRunningTimer: () => request<TimeEntry | null>(`/time/running`),
  startTimer: (body: { projectId: string; taskId?: string; description?: string; billable?: boolean }) =>
    request<TimeEntry>(`/time/start`, { method: "POST", body: JSON.stringify(body) }),
  stopTimer: () => request<TimeEntry | null>(`/time/stop`, { method: "POST" }),
  getTimeEntries: (opts: { userId?: string; projectId?: string; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v) q.set(k, v);
    const qs = q.toString();
    return request<TimeEntry[]>(`/time/entries${qs ? "?" + qs : ""}`);
  },
  createTimeEntry: (body: {
    projectId: string;
    taskId?: string;
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
  setTimesheetCell: (body: { projectId: string; date: string; hours: number; userId?: string }) =>
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
  getDealBoard: () => request<DealColumn[]>(`/crm/deals/board`),
  getDeal: (id: string) => request<Deal>(`/crm/deals/${id}`),
  createDeal: (body: DealInput) =>
    request<Deal>(`/crm/deals`, { method: "POST", body: JSON.stringify(body) }),
  updateDeal: (id: string, body: Partial<DealInput>) =>
    request<Deal>(`/crm/deals/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  moveDeal: (id: string, stage: DealStage, position: number) =>
    request<Deal>(`/crm/deals/${id}/move`, { method: "PATCH", body: JSON.stringify({ stage, position }) }),
  convertDeal: (id: string) => request<Deal>(`/crm/deals/${id}/convert`, { method: "POST" }),
  archiveDeal: (id: string) => request<{ id: string }>(`/crm/deals/${id}`, { method: "DELETE" }),

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
  addNote: (entityType: NoteEntity, entityId: string, body: string) =>
    request<CrmNote>(`/crm/notes/${entityType}/${entityId}`, { method: "POST", body: JSON.stringify({ body }) }),
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
  createList: (spaceId: string, name: string) =>
    request<{ id: string; name: string; spaceId: string }>(`/spaces/${spaceId}/lists`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getTags: (spaceId: string) => request<Tag[]>(`/spaces/${spaceId}/tags`),
  createTag: (spaceId: string, body: { name: string; color?: string }) =>
    request<Tag>(`/spaces/${spaceId}/tags`, { method: "POST", body: JSON.stringify(body) }),
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
  removeMember: (userId: string) =>
    request<{ userId: string }>(`/members/${userId}`, { method: "DELETE" }),

  // ---- Chat: discovery ----
  browseChannels: () =>
    request<{ id: string; name: string | null; topic: string | null; memberCount: number; joined: boolean }[]>(
      `/chat/browse`,
    ),
  joinChannel: (id: string) =>
    request<{ id: string; joined: boolean }>(`/chat/channels/${id}/join`, { method: "POST" }),
  openDm: (userId: string) =>
    request<{ id: string; created: boolean }>(`/chat/dm`, { method: "POST", body: JSON.stringify({ userId }) }),

  // ---- Documents ----
  getDocuments: (projectId?: string) =>
    request<DocSummary[]>(`/documents${projectId ? "?projectId=" + projectId : ""}`),
  getDocument: (id: string) => request<Doc>(`/documents/${id}`),
  createDocument: (body: { title: string; body?: string; projectId?: string | null }) =>
    request<Doc>(`/documents`, { method: "POST", body: JSON.stringify(body) }),
  updateDocument: (id: string, body: { title?: string; body?: string; projectId?: string | null }) =>
    request<Doc>(`/documents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteDocument: (id: string) => request<{ id: string }>(`/documents/${id}`, { method: "DELETE" }),
};

export interface ChatMember {
  id: string;
  name: string;
  avatarUrl: string | null;
}
export interface ChatChannel {
  id: string;
  type: "channel" | "dm";
  name: string | null;
  topic: string | null;
  members: ChatMember[];
}
export interface ChatMessage {
  id: string;
  channelId: string;
  body: string;
  createdAt: string;
  author: ChatMember;
}
