import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ApprovalMeta,
  type AppNotification,
  type DigestItem,
  type DigestSections,
  type InboxTab,
  type MutableEntity,
  type MyTask,
  type NotifType,
  type TypedInboxTab,
  type TaskComment,
} from "../lib/api.js";
import { relativeTime } from "../components/TaskCollaboration.js";
import { PriorityFlag, StatusPill } from "../components/ui.js";
import { cn } from "../lib/utils.js";
import { useToggleMute } from "../components/MuteButton.js";
import { useToggleFollow } from "../components/FollowButton.js";

type Section = "inbox" | "replies" | "assigned" | "mytasks";
type RowFilter = "all" | "unread" | "important";

const VERB_LABEL: Record<string, string> = {
  assigned: "assigned this to you",
  comment_assigned: "assigned you a comment",
  mentioned: "mentioned you",
  posted: "posted",
  follow_up: "— follow-up due",
  digest: "— your summary",
  project_activity: "",
  doc_edited: "edited",
  doc_shared: "shared",
  doc_superseded: "superseded this with",
  due_soon: "— due soon",
  overdue: "— overdue",
  doc_review_requested: "asked you to review",
  milestone_signoff_requested: "asked you to sign off",
  milestone_approved: "signed off",
  milestone_rejected: "declined sign-off on",
  timesheet_submitted: "submitted a timesheet",
  timesheet_approved: "approved your timesheet",
  timesheet_rejected: "sent back your timesheet",
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
  const snooze = useMutation({
    mutationFn: ({ id, until }: { id: string; until: Date }) => api.snoozeNotification(id, until.toISOString()),
    onSuccess: refresh,
  });
  // Row 74: mute the thread behind a row, then clear the row itself.
  const toggleMute = useToggleMute();
  const muteRow = (n: AppNotification) => {
    const target = muteTargetOf(n);
    if (!target) return;
    toggleMute.mutate({ ...target, muted: false });
    archive.mutate(n.id);
  };

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
                      } else if (n.entityType === "project") {
                        navigate({ to: "/projects/$projectId", params: { projectId: n.entityId } });
                      } else if (n.entityType === "timesheet") {
                        navigate({ to: "/timesheets" });
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
                    onSnooze={(until) => snooze.mutate({ id: n.id, until })}
                    onMute={muteTargetOf(n) ? () => muteRow(n) : undefined}
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
  onMute,
  onArchive,
  onRestore,
}: {
  n: AppNotification;
  parked: boolean;
  onOpen: () => void;
  onFlag: () => void;
  onRead: () => void;
  onSnooze: (until: Date) => void;
  /** Row 74: absent when the row's entity can't be muted (e.g. a deal). */
  onMute?: () => void;
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
              <SnoozeMenu onPick={onSnooze} />
              {onMute && <RowAction label="Mute this thread - no more notifications about it" onClick={onMute}>🔕</RowAction>}
              <RowAction label="Clear" onClick={onArchive}>✕</RowAction>
            </>
          )}
        </span>
      </span>
      {n.data?.approval ? <ApprovalCard n={n} approval={n.data.approval as ApprovalMeta} /> : null}
      {n.verb === "digest" && n.data?.sections ? <DigestCard sections={n.data.sections as DigestSections} /> : null}
    </li>
  );
}

/**
 * Row 75: the inline Approve / Reject strip under an approval request
 * (timesheet submitted, milestone sign-off, doc review). Once decided - here
 * or on the item's own page - it shows the outcome instead.
 */
function ApprovalCard({ n, approval }: { n: AppNotification; approval: ApprovalMeta }) {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (body: { approve: boolean; note?: string }) => api.decideApproval(n.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["unread-count"] });
      qc.invalidateQueries({ queryKey: ["milestones"] });
      qc.invalidateQueries({ queryKey: ["timesheet"] });
      qc.invalidateQueries({ queryKey: ["document"] });
    },
  });
  const kindLabel = approval.kind === "doc_review" ? "Doc review" : approval.kind === "milestone" ? "Milestone sign-off" : "Timesheet";

  if (approval.status !== "pending") {
    const ok = approval.status === "approved";
    return (
      <div className="col-span-full ml-5 flex flex-wrap items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
        <span className={cn("rounded-full px-2 py-0.5 font-medium", ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")}>
          {ok ? "✓ Approved" : "✕ Rejected"}
        </span>
        <span className="text-muted-foreground">
          {kindLabel}
          {approval.decidedAt ? ` · ${new Date(approval.decidedAt).toLocaleDateString()}` : ""}
          {approval.note ? ` · “${approval.note}”` : ""}
        </span>
      </div>
    );
  }
  return (
    <div className="col-span-full ml-5 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{kindLabel} · awaiting you</span>
      {rejecting ? (
        <>
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why? (optional)"
            className="w-56 rounded-md border border-border px-2 py-1 text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") decide.mutate({ approve: false, note: note.trim() || undefined });
              if (e.key === "Escape") setRejecting(false);
            }}
          />
          <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ approve: false, note: note.trim() || undefined })} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
            Confirm reject
          </button>
          <button type="button" onClick={() => setRejecting(false)} className="text-xs text-slate-500 hover:underline">
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ approve: true })} className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">
            ✓ Approve
          </button>
          <button type="button" disabled={decide.isPending} onClick={() => setRejecting(true)} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-red-50 hover:text-red-700 disabled:opacity-50">
            ✕ Reject
          </button>
        </>
      )}
      {decide.isError && <span className="text-xs text-red-600">{(decide.error as Error).message}</span>}
    </div>
  );
}

/** Row 76: the expanded digest under its inbox row - every item links to the thing itself. */
function DigestCard({ sections }: { sections: DigestSections }) {
  const navigate = useNavigate();
  const Group = ({ label, items, tone }: { label: string; items: DigestItem[]; tone: string }) =>
    items.length ? (
      <div>
        <p className={cn("text-[11px] font-semibold uppercase tracking-wide", tone)}>
          {label} · {items.length}
        </p>
        <ul className="mt-0.5 space-y-0.5">
          {items.slice(0, 8).map((i) => (
            <li key={i.id} className="truncate text-xs text-slate-700">
              <button type="button" onClick={() => i.link && navigate({ to: i.link as "/" })} className="hover:underline">
                {i.title}
              </button>
              {i.meta && /^\d{4}-\d{2}-\d{2}T/.test(i.meta) ? <span className="text-muted-foreground"> · {new Date(i.meta).toLocaleDateString()}</span> : null}
            </li>
          ))}
          {items.length > 8 && <li className="text-[11px] text-muted-foreground">+{items.length - 8} more</li>}
        </ul>
      </div>
    ) : null;
  const empty = !sections.dueToday.length && !sections.overdue.length && !sections.assignments.length && !sections.mentions.length;
  return (
    <div className="col-span-full ml-5 grid gap-3 rounded-md border border-border bg-[#fbfbfa] p-3 sm:grid-cols-2" onClick={(e) => e.stopPropagation()}>
      {empty ? (
        <p className="text-xs text-muted-foreground">All clear - nothing due, overdue, newly assigned or unread.</p>
      ) : (
        <>
          <Group label="Due today" items={sections.dueToday} tone="text-indigo-700" />
          <Group label="Overdue" items={sections.overdue} tone="text-red-700" />
          <Group label="New assignments" items={sections.assignments} tone="text-slate-700" />
          <Group label="Unread mentions" items={sections.mentions} tone="text-amber-700" />
        </>
      )}
    </div>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Row 76: schedule + channels for the digest, and a "send now" for instant gratification. */
function DigestSettings() {
  const qc = useQueryClient();
  const { data: prefs } = useQuery({ queryKey: ["notification-preferences"], queryFn: api.getNotificationPreferences });
  const update = useMutation({
    mutationFn: api.updateNotificationPreferences,
    onSuccess: (next) => qc.setQueryData(["notification-preferences"], next),
  });
  const sendNow = useMutation({
    mutationFn: api.sendDigestNow,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["unread-count"] });
    },
  });
  const d = prefs?.digest;
  if (!d) return null;
  const set = (patch: Partial<typeof d>) => update.mutate({ digest: patch });
  const sel = "rounded-md border border-border bg-white px-1.5 py-0.5 text-xs";
  return (
    <div className="mt-1 border-t border-border px-2 pt-2">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Digest</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
        <select value={d.frequency} onChange={(e) => set({ frequency: e.target.value as typeof d.frequency })} className={sel}>
          <option value="off">Off</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        {d.frequency === "weekly" && (
          <select value={d.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} className={sel}>
            {WEEKDAYS.map((w, i) => (
              <option key={w} value={i}>
                {w}
              </option>
            ))}
          </select>
        )}
        {d.frequency !== "off" && (
          <select value={d.hour} onChange={(e) => set({ hour: Number(e.target.value) })} className={sel} title="Send at">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`}
              </option>
            ))}
          </select>
        )}
        {d.frequency !== "off" && (
          <>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={d.inApp} onChange={(e) => set({ inApp: e.target.checked })} className="accent-indigo-600" /> In-app
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={d.email} onChange={(e) => set({ email: e.target.checked })} className="accent-indigo-600" /> Email
            </label>
          </>
        )}
        <button type="button" onClick={() => sendNow.mutate()} disabled={sendNow.isPending} className="ml-auto text-indigo-600 hover:underline disabled:opacity-50" title="Compose and deliver a digest right now">
          {sendNow.isPending ? "Sending…" : sendNow.isSuccess ? "Sent ✓" : "Send me one now"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">Tasks due today, overdue items, new assignments and unread mentions - one message instead of twenty.</p>
    </div>
  );
}

/** Row 77: everything I follow, with one-click unfollow. */
function FollowingList() {
  const { data: follows = [] } = useQuery({ queryKey: ["follows"], queryFn: api.getFollows });
  const toggle = useToggleFollow();
  if (!follows.length) return null;
  return (
    <div className="mt-1 border-t border-border px-2 pt-2">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Following · {follows.length}</p>
      <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs">
        {follows.map((f) => (
          <li key={f.id} className="flex items-center gap-2">
            <span className="text-muted-foreground">{f.entityType === "document" ? "doc" : f.entityType}</span>
            <span className="truncate text-slate-700">{f.name}</span>
            <button
              type="button"
              onClick={() => toggle.mutate({ entityType: f.entityType, entityId: f.entityId, following: true })}
              className="ml-auto shrink-0 text-indigo-600 hover:underline"
            >
              Unfollow
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Row 74: everything I've muted, with one-click unmute. */
function MutedList() {
  const { data: mutes = [] } = useQuery({ queryKey: ["mutes"], queryFn: api.getMutes });
  const toggle = useToggleMute();
  if (!mutes.length) return null;
  return (
    <div className="mt-1 border-t border-border px-2 pt-2">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Muted</p>
      <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs">
        {mutes.map((m) => (
          <li key={m.id} className="flex items-center gap-2">
            <span className="text-muted-foreground">{m.entityType === "document" ? "doc" : m.entityType}</span>
            <span className="truncate text-slate-700">{m.name}</span>
            <button
              type="button"
              onClick={() => toggle.mutate({ entityType: m.entityType, entityId: m.entityId, muted: true })}
              className="ml-auto shrink-0 text-indigo-600 hover:underline"
            >
              Unmute
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const NOTIF_TYPE_ROWS: { key: NotifType; label: string }[] = [
  { key: "mention", label: "Mentions & assigned comments" },
  { key: "assigned", label: "Task assigned to me" },
  { key: "approvals", label: "Approvals & sign-offs" },
  { key: "reminders", label: "Due-date reminders & follow-ups" },
  { key: "comment", label: "Comments on tasks I follow" },
  { key: "statusChange", label: "Status changes" },
  { key: "propertyChange", label: "Property changes" },
  { key: "taskCompleted", label: "Task completed" },
  { key: "chat", label: "Chat activity" },
  { key: "following", label: "Activity on things I follow" },
];
const CHANNELS: { key: "inApp" | "email" | "push"; label: string }[] = [
  { key: "inApp", label: "In-app" },
  { key: "email", label: "Email" },
  { key: "push", label: "Push" },
];

/**
 * Row 73: per-type channel matrix. In-app = lands in this inbox; Email = sent
 * to your address; Push = a browser/desktop notification while the app is open.
 */
function PreferencesPopover({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: prefs } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: api.getNotificationPreferences,
  });
  const update = useMutation({
    mutationFn: api.updateNotificationPreferences,
    onSuccess: (next) => qc.setQueryData(["notification-preferences"], next),
  });
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const askPush = async () => {
    if (typeof Notification === "undefined") return;
    setPerm(await Notification.requestPermission());
  };

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute right-0 top-full z-30 mt-1 w-[26rem] rounded-md border border-border bg-white p-2 shadow-lg">
        <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Notify me about
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-muted-foreground">
              <th className="px-2 py-1 text-left font-medium">Type</th>
              {CHANNELS.map((c) => (
                <th key={c.key} className="w-14 px-1 py-1 text-center font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIF_TYPE_ROWS.map((row) => (
              <tr key={row.key} className="hover:bg-muted">
                <td className="rounded-l px-2 py-1.5 text-slate-700">{row.label}</td>
                {CHANNELS.map((c) => (
                  <td key={c.key} className="px-1 py-1.5 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${row.label} - ${c.label}`}
                      checked={Boolean(prefs?.channels[row.key]?.[c.key])}
                      disabled={!prefs}
                      onChange={(e) => update.mutate({ [row.key]: { [c.key]: e.target.checked } })}
                      className="accent-indigo-600"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <DigestSettings />
        <FollowingList />
        <MutedList />
        <div className="mt-1 space-y-1 border-t border-border px-2 pt-2 text-[11px] text-muted-foreground">
          {prefs && !prefs.emailConfigured && <p>Email is not connected on this server yet - switches are saved, mail goes out once it is.</p>}
          {perm === "unsupported" ? (
            <p>This browser can't show push notifications.</p>
          ) : perm === "granted" ? (
            <p>Push shows as a browser notification while the app is open.</p>
          ) : (
            <button type="button" onClick={askPush} className="text-indigo-600 hover:underline">
              {perm === "denied" ? "Browser notifications are blocked - allow them in site settings" : "Enable browser notifications for push"}
            </button>
          )}
        </div>
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

/** Row 74: which thread a notification belongs to, for the row's Mute action. */
function muteTargetOf(n: AppNotification): { entityType: MutableEntity; entityId: string } | null {
  if (n.entityType === "task" || n.entityType === "document") return { entityType: n.entityType, entityId: n.entityId };
  if (n.entityType === "project") return { entityType: "project", entityId: n.entityId };
  if (n.entityType === "milestone" && typeof n.data?.projectId === "string") return { entityType: "project", entityId: n.data.projectId };
  return null;
}

/** Row 74: snooze presets instead of a fixed "one day". */
function snoozePresets(): { label: string; until: Date }[] {
  const now = new Date();
  const at = (d: Date, h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return x;
  };
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  const evening = at(now, 18);
  return [
    { label: "In 1 hour", until: new Date(now.getTime() + 3_600_000) },
    ...(evening > now ? [{ label: "This evening (6pm)", until: evening }] : []),
    { label: "Tomorrow 9am", until: at(tomorrow, 9) },
    { label: "Next Monday 9am", until: at(monday, 9) },
  ];
}

function SnoozeMenu({ onPick }: { onPick: (until: Date) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <RowAction label="Snooze until…" onClick={() => setOpen((o) => !o)}>⏰</RowAction>
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span className="absolute right-0 top-full z-30 mt-1 flex w-44 flex-col rounded-md border border-border bg-white py-1 text-left shadow-lg">
            {snoozePresets().map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(p.until);
                }}
                className="px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-muted"
              >
                {p.label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
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
