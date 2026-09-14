import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AppNotification,
  type InboxTab,
  type MyTask,
  type TypedInboxTab,
  type TaskComment,
} from "../lib/api.js";
import { relativeTime } from "../components/TaskCollaboration.js";
import { PriorityFlag, StatusPill } from "../components/ui.js";
import { cn } from "../lib/utils.js";

type Section = "inbox" | "replies" | "assigned" | "mytasks";
type RowFilter = "all" | "unread" | "important";

const VERB_LABEL: Record<string, string> = {
  assigned: "assigned this to you",
  comment_assigned: "assigned you a comment",
  mentioned: "mentioned you",
  posted: "posted",
  follow_up: "— follow-up due",
  due_soon: "— due soon",
  overdue: "— overdue",
  doc_review_requested: "asked you to review",
  doc_approved: "approved",
  doc_rejected: "sent back",
  proposal_viewed: "— proposal viewed",
  proposal_accepted: "— proposal accepted 🎉",
  proposal_declined: "— proposal declined",
  commented: "commented",
  status_changed: "changed the status",
  completed: "marked this complete",
  updated: "made changes",
};

/** Row 71: tabs by type. The typed ones carry an unread count; Later/Cleared are parking spots. */
const TABS: { key: InboxTab; label: string; hint?: string }[] = [
  { key: "all", label: "All" },
  { key: "mentions", label: "Mentions", hint: "@you and assigned comments" },
  { key: "assigned", label: "Assigned", hint: "tasks handed to you" },
  { key: "approvals", label: "Approvals", hint: "reviews & sign-offs" },
  { key: "alerts", label: "Alerts", hint: "follow-ups, status changes" },
  { key: "later", label: "Later" },
  { key: "cleared", label: "Cleared" },
];
const TYPED_TABS = new Set<InboxTab>(["all", "mentions", "assigned", "approvals", "alerts"]);
const isTyped = (t: InboxTab): t is TypedInboxTab => TYPED_TABS.has(t);

/**
 * ClickUp-style Home: a sub-navigation column (Inbox, Replies, Assigned
 * Comments, My Tasks) and the selected section beside it. Everything here is a
 * *view over* data the rest of the app already produces — nothing is written
 * on this page except read/flag/snooze/archive state.
 */
export function HomePage() {
  const [section, setSection] = useState<Section>("inbox");

  const { data: counts } = useQuery({ queryKey: ["unread-count"], queryFn: api.getUnreadCount });
  const { data: assignedCount } = useQuery({
    queryKey: ["assigned-comments-count"],
    queryFn: api.getAssignedCommentsCount,
  });

  return (
    <div className="flex h-screen flex-1 overflow-hidden bg-white">
      {/* Sub-navigation */}
      <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-[#fbfbfa] px-2 py-3">
        <p className="mb-2 px-2 text-sm font-semibold text-slate-800">Home</p>
        <SubNavItem
          active={section === "inbox"}
          onClick={() => setSection("inbox")}
          label="Inbox"
          badge={counts?.count}
          icon={<path d="M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 012-2h12a2 2 0 012 2v7m-16 0v5a2 2 0 002 2h12a2 2 0 002-2v-5" stroke="currentColor" strokeWidth="1.8" />}
        />
        <SubNavItem
          active={section === "replies"}
          onClick={() => setSection("replies")}
          label="Replies"
          badge={counts?.replies}
          icon={<path d="M9 17l-5-5 5-5M4 12h11a5 5 0 015 5v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
        />
        <SubNavItem
          active={section === "assigned"}
          onClick={() => setSection("assigned")}
          label="Assigned Comments"
          badge={assignedCount?.count}
          icon={<path d="M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21a8 8 0 0116 0" stroke="currentColor" strokeWidth="1.8" />}
        />
        <SubNavItem
          active={section === "mytasks"}
          onClick={() => setSection("mytasks")}
          label="My Tasks"
          icon={<path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
        />

        <p className="mb-1 mt-4 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          More
        </p>
        <MoreLink to="/chat" label="Chat activity" />
        <MoreLink to="/chat" label="All channels" />
        <MoreLink to="/" label="All spaces" />
      </nav>

      {/* Section */}
      {section === "inbox" && <InboxSection />}
      {section === "replies" && <RepliesSection />}
      {section === "assigned" && <AssignedCommentsSection />}
      {section === "mytasks" && <MyTasksSection />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Inbox
 * ------------------------------------------------------------------ */

function InboxSection() {
  const [tab, setTab] = useState<InboxTab>("all");
  const { data: counts } = useQuery({ queryKey: ["unread-count"], queryFn: api.getUnreadCount });
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["unread-count"] });
  };

  const clearAll = useMutation({
    mutationFn: () => api.clearAllNotifications(isTyped(tab) ? tab : undefined),
    onSuccess: refresh,
  });
  const readAll = useMutation({
    mutationFn: () => api.markAllNotificationsRead(isTyped(tab) ? tab : undefined),
    onSuccess: refresh,
  });

  const tabCount = (key: InboxTab) => (isTyped(key) ? counts?.[key] : undefined);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex border-b border-border px-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px flex flex-col items-start gap-0.5 border-b-2 px-4 py-2.5 text-left transition",
              tab === t.key
                ? "border-indigo-600 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700",
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {t.label}
              {tabCount(t.key) ? (
                <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] font-semibold leading-4 text-white">
                  {tabCount(t.key)}
                </span>
              ) : null}
            </span>
            <span className="text-[11px] text-muted-foreground">{t.hint ?? " "}</span>
          </button>
        ))}
      </div>

      <NotificationList
        tab={tab}
        showClearAll={isTyped(tab)}
        onClearAll={() => clearAll.mutate()}
        onReadAll={() => readAll.mutate()}
        unread={tabCount(tab) ?? 0}
      />
    </div>
  );
}

function RepliesSection() {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold text-slate-800">Replies</h2>
        <p className="text-xs text-muted-foreground">Comments and mentions on tasks you follow</p>
      </div>
      <NotificationList tab="replies" showClearAll={false} onClearAll={() => undefined} onReadAll={() => undefined} unread={0} />
    </div>
  );
}

/**
 * The list body shared by every notification-backed section: filter, settings,
 * month grouping, and per-row actions that depend on which tab we're in.
 */
function NotificationList({
  tab,
  showClearAll,
  onClearAll,
  onReadAll,
  unread,
}: {
  tab: InboxTab;
  showClearAll: boolean;
  onClearAll: () => void;
  onReadAll: () => void;
  /** Unread count for this tab - enables "Mark all read". */
  unread: number;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RowFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["notifications", tab],
    queryFn: () => api.getNotifications(tab),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["unread-count"] });
  };
  const act = (fn: (id: string) => Promise<unknown>) =>
    useMutation({ mutationFn: fn, onSuccess: refresh });

  const markRead = act(api.markNotificationRead);
  const archive = act(api.archiveNotification);
  const restore = act(api.restoreNotification);
  const flag = act(api.toggleNotificationImportant);
  const snooze = act((id) =>
    api.snoozeNotification(id, new Date(Date.now() + 86_400_000).toISOString()),
  );

  const visible = useMemo(
    () =>
      items.filter((n) =>
        filter === "unread" ? !n.readAt : filter === "important" ? n.isImportant : true,
      ),
    [items, filter],
  );

  const groups = useMemo(() => groupByMonth(visible), [visible]);
  const parked = tab === "later" || tab === "cleared";

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-6 py-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as RowFilter)}
          className="rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
        >
          <option value="all">All</option>
          <option value="unread">Unread</option>
          <option value="important">Important</option>
        </select>

        <div className="relative ml-auto">
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            title="Notification settings"
            className="rounded-md border border-border p-1.5 text-slate-500 transition hover:bg-muted"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
              <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          {settingsOpen && <PreferencesPopover onClose={() => setSettingsOpen(false)} />}
        </div>

        {showClearAll && (
          <button
            onClick={onReadAll}
            disabled={!unread}
            title="Mark every notification in this tab as read"
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-muted disabled:opacity-40"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
              <path d="M2 12l5 5L17 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Mark all read
          </button>
        )}
        {showClearAll && (
          <button
            onClick={onClearAll}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-muted"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
              <path d="M3 12l4 4L14 9M9 17l2 2 10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Clear all
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : groups.length ? (
          groups.map((g) => (
            <section key={g.label} className="mb-6">
              <h3 className="mb-2 text-sm font-semibold text-slate-800">{g.label}</h3>
              <ul className="overflow-hidden rounded-lg border border-border">
                {g.items.map((n) => (
                  <NotificationRow
                    key={n.id}
                    n={n}
                    parked={parked}
                    onOpen={() => {
                      if (!n.readAt) markRead.mutate(n.id);
                      if (n.entityType === "task") {
                        navigate({ to: "/t/$taskId", params: { taskId: n.entityId } });
                      } else if (n.entityType === "document") {
                        navigate({ to: "/docs/$docId", params: { docId: n.entityId } });
                      } else if (n.entityType === "proposal") {
                        navigate({ to: "/crm/proposals/$proposalId", params: { proposalId: n.entityId } });
                      } else if (n.entityType === "deal") {
                        navigate({ to: "/crm/deals", search: { deal: n.entityId } });
                      } else if (n.entityType === "milestone" && typeof n.data?.projectId === "string") {
                        // Row 72: a milestone reminder opens its project.
                        navigate({ to: "/projects/$projectId", params: { projectId: n.data.projectId } });
                      } else if (n.entityType === "message" && typeof n.data?.channelId === "string") {
                        // Row 41: a chat mention opens the channel it happened in.
                        navigate({ to: "/chat/$channelId", params: { channelId: n.data.channelId } });
                      }
                    }}
                    onFlag={() => flag.mutate(n.id)}
                    onRead={() => markRead.mutate(n.id)}
                    onSnooze={() => snooze.mutate(n.id)}
                    onArchive={() => archive.mutate(n.id)}
                    onRestore={() => restore.mutate(n.id)}
                  />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <Empty
            text={
              tab === "later"
                ? "Nothing snoozed."
                : tab === "cleared"
                  ? "Nothing cleared yet."
                  : filter !== "all"
                    ? "Nothing matches this filter."
                    : "You are all caught up."
            }
          />
        )}
      </div>
    </>
  );
}

function NotificationRow({
  n,
  parked,
  onOpen,
  onFlag,
  onRead,
  onSnooze,
  onArchive,
  onRestore,
}: {
  n: AppNotification;
  parked: boolean;
  onOpen: () => void;
  onFlag: () => void;
  onRead: () => void;
  onSnooze: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const unread = !n.readAt && !parked;
  const initials = (n.triggeredBy?.name ?? "?")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <li
      onClick={onOpen}
      className={cn(
        "group grid cursor-pointer grid-cols-[auto_minmax(0,1.1fr)_auto_minmax(0,1.4fr)_auto_auto_auto] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 transition hover:bg-[#fbfbfa]",
        unread && "bg-indigo-50/30",
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          unread ? "bg-indigo-500" : "bg-slate-200",
        )}
      />

      <span className={cn("truncate text-sm", unread ? "font-semibold text-slate-900" : "text-slate-700")}>
        {n.title}
      </span>

      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700"
        title={n.triggeredBy?.name}
      >
        {initials}
      </span>

      <span className="truncate text-sm text-slate-600">
        <span className="font-medium text-slate-800">{n.triggeredBy?.name ?? "System"}</span>{" "}
        {VERB_LABEL[n.verb] ?? n.verb}
        {n.body ? <span className="text-muted-foreground"> — {n.body}</span> : null}
      </span>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onFlag();
        }}
        title={n.isImportant ? "Unflag" : "Flag as important"}
        className={cn(
          "rounded p-1 transition",
          n.isImportant
            ? "text-red-500"
            : "text-slate-300 opacity-0 group-hover:opacity-100 hover:text-red-400",
        )}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill={n.isImportant ? "currentColor" : "none"}>
          <path d="M5 3v18M5 4h11l-2 3 2 3H5" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>

      <span
        className="flex h-5 min-w-[20px] items-center justify-center rounded-full border border-border px-1.5 text-[11px] tabular-nums text-slate-600"
        title={`${n.replyCount} comments`}
      >
        {n.replyCount}
      </span>

      <span className="relative w-16 text-right text-xs text-muted-foreground">
        <span className="group-hover:invisible">{shortDate(n.createdAt)}</span>
        <span
          className="invisible absolute inset-y-0 right-0 flex items-center gap-0.5 group-hover:visible"
          onClick={(e) => e.stopPropagation()}
        >
          {parked ? (
            <RowAction label="Restore to inbox" onClick={onRestore}>↩</RowAction>
          ) : (
            <>
              {unread && <RowAction label="Mark read" onClick={onRead}>✓</RowAction>}
              <RowAction label="Snooze a day" onClick={onSnooze}>⏰</RowAction>
              <RowAction label="Clear" onClick={onArchive}>✕</RowAction>
            </>
          )}
        </span>
      </span>
    </li>
  );
}

function PreferencesPopover({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: prefs } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: api.getNotificationPreferences,
  });
  const update = useMutation({
    mutationFn: api.updateNotificationPreferences,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-preferences"] }),
  });

  const rows: { key: keyof NonNullable<typeof prefs>; label: string }[] = [
    { key: "propertyChange", label: "Property changes" },
    { key: "statusChange", label: "Status changes" },
    { key: "comment", label: "Comments" },
    { key: "mention", label: "Mentions and assigned comments" },
    { key: "taskCompleted", label: "Task completed" },
  ];

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-md border border-border bg-white p-2 shadow-lg">
        <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Notify me about
        </p>
        {rows.map((r) => (
          <label
            key={r.key}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-muted"
          >
            <input
              type="checkbox"
              checked={Boolean(prefs?.[r.key])}
              onChange={(e) => update.mutate({ [r.key]: e.target.checked })}
              className="accent-indigo-600"
            />
            {r.label}
          </label>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Assigned comments
 * ------------------------------------------------------------------ */

function AssignedCommentsSection() {
  const qc = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const { data: items = [] } = useQuery({
    queryKey: ["assigned-comments", showResolved],
    queryFn: () => api.getAssignedComments(showResolved),
  });
  const resolve = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      api.resolveComment(id, resolved),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assigned-comments"] });
      qc.invalidateQueries({ queryKey: ["assigned-comments-count"] });
    },
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center border-b border-border px-6 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Assigned Comments</h2>
          <p className="text-xs text-muted-foreground">Comments handed to you as action items</p>
        </div>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="accent-indigo-600"
          />
          Show resolved
        </label>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {items.length ? (
          <ul className="overflow-hidden rounded-lg border border-border">
            {items.map((c) => (
              <AssignedCommentRow
                key={c.id}
                c={c}
                onToggle={() => resolve.mutate({ id: c.id, resolved: !c.resolvedAt })}
              />
            ))}
          </ul>
        ) : (
          <Empty text="No comments are assigned to you." />
        )}
      </div>
    </div>
  );
}

function AssignedCommentRow({ c, onToggle }: { c: TaskComment; onToggle: () => void }) {
  const done = Boolean(c.resolvedAt);
  return (
    <li className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <button
        onClick={onToggle}
        title={done ? "Reopen" : "Resolve"}
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition",
          done
            ? "border-green-500 bg-green-500 text-white"
            : "border-slate-300 text-transparent hover:border-indigo-500 hover:text-indigo-500",
        )}
      >
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none">
          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm text-slate-800", done && "text-muted-foreground line-through")}>
          {c.body}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium text-slate-700">{c.author.name}</span>
          {c.task ? (
            <>
              {" "}on <span className="font-medium text-slate-700">{c.task.title}</span>
            </>
          ) : null}
          {" · "}
          {relativeTime(c.createdAt)}
        </p>
      </div>
      {c.task?.status && <StatusPill name={c.task.status.name} color={c.task.status.color} />}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * My tasks
 * ------------------------------------------------------------------ */

function MyTasksSection() {
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["my-tasks"],
    queryFn: () => api.getMyTasks(),
  });
  const groups = useMemo(() => groupByDue(tasks), [tasks]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold text-slate-800">My Tasks</h2>
        <p className="text-xs text-muted-foreground">Everything assigned to you, across every list</p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : groups.length ? (
          groups.map((g) => (
            <section key={g.label} className="mb-6">
              <h3 className={cn("mb-2 text-sm font-semibold", g.tone)}>
                {g.label}{" "}
                <span className="font-normal text-muted-foreground">{g.items.length}</span>
              </h3>
              <ul className="overflow-hidden rounded-lg border border-border">
                {g.items.map((t) => (
                  <li
                    key={t.id}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-[#fbfbfa]"
                  >
                    <span className="w-12 text-[11px] text-muted-foreground">{t.reference ?? ""}</span>
                    <Link
                      to="/l/$listId"
                      params={{ listId: (t as MyTask).list?.id ?? "" }}
                      className="truncate text-sm text-slate-800 hover:text-indigo-700"
                    >
                      {t.title}
                      {(t as MyTask).list && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          in {(t as MyTask).list!.name}
                        </span>
                      )}
                    </Link>
                    {t.status ? (
                      <StatusPill name={t.status.name} color={t.status.color} />
                    ) : (
                      <span />
                    )}
                    <PriorityFlag priority={t.priority} />
                    <span className="w-16 text-right text-xs text-muted-foreground">
                      {t.dueDate ? shortDate(t.dueDate) : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <Empty text="Nothing is assigned to you right now." />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Bits
 * ------------------------------------------------------------------ */

function SubNavItem({
  active,
  onClick,
  label,
  badge,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
  icon: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition",
        active
          ? "bg-indigo-50 font-medium text-indigo-700"
          : "text-slate-600 hover:bg-muted",
      )}
    >
      <svg className="h-4 w-4 opacity-70" viewBox="0 0 24 24" fill="none">
        {icon}
      </svg>
      <span className="truncate">{label}</span>
      {badge ? (
        <span className="ml-auto min-w-[18px] rounded-full bg-indigo-600 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

function MoreLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-muted"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
      {label}
    </Link>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className="rounded px-1 py-0.5 text-xs text-slate-500 transition hover:bg-muted hover:text-slate-700"
    >
      {children}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
      <span className="text-2xl">📭</span>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

/** "August" for this year, "August 2025" for older — like the reference UI. */
function groupByMonth(items: AppNotification[]) {
  const now = new Date();
  const groups: { label: string; items: AppNotification[] }[] = [];
  for (const n of items) {
    const d = new Date(n.createdAt);
    const label =
      d.getFullYear() === now.getFullYear()
        ? d.toLocaleString(undefined, { month: "long" })
        : d.toLocaleString(undefined, { month: "long", year: "numeric" });
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return groups;
}

function groupByDue(tasks: MyTask[]) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const buckets: Record<string, MyTask[]> = { Overdue: [], Today: [], Upcoming: [], "No due date": [] };
  for (const t of tasks) {
    if (!t.dueDate) buckets["No due date"]!.push(t);
    else {
      const d = new Date(t.dueDate);
      if (d < start) buckets["Overdue"]!.push(t);
      else if (d < end) buckets["Today"]!.push(t);
      else buckets["Upcoming"]!.push(t);
    }
  }
  const tone: Record<string, string> = {
    Overdue: "text-red-600",
    Today: "text-indigo-700",
    Upcoming: "text-slate-800",
    "No due date": "text-slate-500",
  };
  return Object.entries(buckets)
    .filter(([, items]) => items.length)
    .map(([label, items]) => ({ label, items, tone: tone[label]! }));
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
