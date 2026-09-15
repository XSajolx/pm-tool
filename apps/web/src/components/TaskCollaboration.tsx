import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ActivityEntry,
  type Member,
  type RelationKind,
  type Status,
} from "../lib/api.js";
import { Avatar } from "./ui.js";
import { MuteButton } from "./MuteButton.js";
import { FollowButton } from "./FollowButton.js";
import { TaskTimerButton } from "./TaskTimerButton.js";
import { TaskAttachments } from "./TaskAttachments.js";
import { cn } from "../lib/utils.js";

const QUICK_EMOJI = ["👍", "🎉", "🚀", "👀", "🔥"];

const RELATION_LABEL: Record<RelationKind, string> = {
  blocks: "Blocks",
  blocked_by: "Blocked by",
  duplicates: "Duplicates",
  relates_to: "Relates to",
};

/** Field names as a person would say them, for the activity feed. */
const FIELD_LABEL: Record<string, string> = {
  statusId: "status",
  listId: "list",
  dueDate: "due date",
  startDate: "start date",
  timeEstimateMinutes: "estimate",
  assignee: "assignee",
  priority: "priority",
  title: "title",
  description: "description",
  stageId: "stage",
  milestoneId: "milestone",
  tag: "tag",
};

/** Value formatting per field, so the timeline reads like a person wrote it. */
function fmtValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (field === "dueDate" || field === "startDate") {
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  if (field === "timeEstimateMinutes") {
    const m = Number(v);
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return h && rest ? `${h}h ${rest}m` : h ? `${h}h` : `${rest}m`;
  }
  if (field === "stageId" || field === "milestoneId") return "another one";
  if (field === "description") return "new text";
  const str = String(v);
  return str.length > 40 ? `${str.slice(0, 40)}…` : str;
}

interface Props {
  taskId: string;
  listId: string;
  statuses: Status[];
}

/**
 * Everything social about a task: reactions, following, links to other tasks,
 * comments and the audit trail. Split out of TaskDetail because it owns a lot of
 * its own server state and none of the task's editable fields.
 */
export function TaskCollaboration({ taskId, listId, statuses }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"comments" | "activity">("comments");
  const [draft, setDraft] = useState("");
  // Mentions picked from the popover. Names typed by hand are matched
  // server-side too, so this list is a convenience, not the only path.
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [assigneeId, setAssigneeId] = useState("");
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const mentionQuery = mentionToken(draft);
  const suggestions =
    mentionQuery === null
      ? []
      : members.filter((m) => m.name.toLowerCase().startsWith(mentionQuery)).slice(0, 5);

  const { data: reactions = [] } = useQuery({
    queryKey: ["reactions", "task", taskId],
    queryFn: () => api.getReactions("task", taskId),
  });
  const { data: relations = [] } = useQuery({
    queryKey: ["relations", taskId],
    queryFn: () => api.getRelations(taskId),
  });
  const { data: activity = [] } = useQuery({
    queryKey: ["activity", taskId],
    queryFn: () => api.getActivity(taskId),
  });
  const { data: task } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.getTask(taskId),
  });

  const react = useMutation({
    mutationFn: (emoji: string) => api.toggleReaction("task", taskId, emoji),
    onSuccess: (next) => qc.setQueryData(["reactions", "task", taskId], next),
  });

  const comment = useMutation({
    mutationFn: (body: string) =>
      api.addComment(taskId, {
        body,
        mentionedUserIds: mentionIds.length ? mentionIds : undefined,
        assigneeId: assigneeId || undefined,
      }),
    onSuccess: () => {
      setDraft("");
      setMentionIds([]);
      setAssigneeId("");
      qc.invalidateQueries({ queryKey: ["task", taskId] });
      qc.invalidateQueries({ queryKey: ["activity", taskId] });
    },
  });

  /** Replaces the half-typed @token with the chosen name and remembers the id. */
  function pickMention(m: Member) {
    setDraft((d) => d.replace(/@[^\s@]*$/, `@${m.name} `));
    setMentionIds((ids) => (ids.includes(m.id) ? ids : [...ids, m.id]));
  }

  const unlink = useMutation({
    mutationFn: (relationId: string) => api.removeRelation(taskId, relationId),
    onSuccess: (next) => qc.setQueryData(["relations", taskId], next),
  });

  return (
    <>
      {/* Reactions + follow */}
      <div className="flex items-center gap-1.5 border-t border-border px-5 py-3">
        {reactions.map((r) => (
          <button
            key={r.emoji}
            onClick={() => react.mutate(r.emoji)}
            title={r.users.map((u) => u.name).join(", ")}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition",
              r.reacted
                ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                : "border-border bg-white text-slate-600 hover:bg-muted",
            )}
          >
            <span>{r.emoji}</span>
            <span className="tabular-nums">{r.count}</span>
          </button>
        ))}

        <EmojiPicker onPick={(e) => react.mutate(e)} />

        <span className="ml-auto" />
        <TaskTimerButton taskId={taskId} label />
        <FollowButton entityType="task" entityId={taskId} />
        <MuteButton entityType="task" entityId={taskId} />
      </div>

      {/* Relations */}
      <div className="border-t border-border px-5 py-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Linked tasks
          </p>
          <AddRelation taskId={taskId} listId={listId} />
        </div>

        {relations.length ? (
          <ul className="space-y-1.5">
            {relations.map((r) => (
              <li
                key={r.id}
                className="group flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                  {RELATION_LABEL[r.relation]}
                </span>
                <span className="truncate text-sm text-slate-700">
                  {r.task?.title ?? "Unknown task"}
                </span>
                <button
                  onClick={() => unlink.mutate(r.id)}
                  className="ml-auto shrink-0 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-500"
                  title="Remove link"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No linked tasks.</p>
        )}
      </div>

      {/* Row 2: attachments */}
      <TaskAttachments taskId={taskId} />

      {/* Comments / activity */}
      <div className="border-t border-border">
        <div className="flex gap-1 px-5 pt-3">
          {(["comments", "activity"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition",
                tab === t
                  ? "bg-muted text-slate-800"
                  : "text-muted-foreground hover:text-slate-700",
              )}
            >
              {t}
              {t === "comments" && task?.comments?.length
                ? ` (${task.comments.length})`
                : ""}
            </button>
          ))}
        </div>

        {tab === "comments" ? (
          <div className="px-5 py-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) comment.mutate(draft.trim());
              }}
              className="mb-3"
            >
              <div className="relative">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Leave a comment… type @ to mention someone"
                  rows={2}
                  className="w-full resize-none rounded-md border border-border p-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                />
                {suggestions.length > 0 && (
                  <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-border bg-white py-1 shadow-lg">
                    {suggestions.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault(); // keep textarea focus
                          pickMention(m);
                        }}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-muted"
                      >
                        <Avatar user={m} size={20} />
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <select
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                  title="Assign this comment as an action item"
                  className="rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-600"
                >
                  <option value="">Assign to…</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={!draft.trim() || comment.isPending}
                  className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
                >
                  {comment.isPending ? "Posting…" : "Comment"}
                </button>
              </div>
            </form>

            {task?.comments?.length ? (
              <ul className="space-y-3">
                {task.comments.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <Avatar user={c.author} size={24} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-700">{c.author.name}</p>
                      <p className="whitespace-pre-wrap break-words text-sm text-slate-600">
                        {c.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No comments yet.</p>
            )}
          </div>
        ) : (
          <div className="px-5 py-3">
            {activity.length ? (
              <ul className="space-y-2.5">
                {activity.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} statuses={statuses} members={members} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Renders one audit row as a sentence, resolving ids to names where it can. */
function ActivityRow({
  entry,
  statuses,
  members,
}: {
  entry: ActivityEntry;
  statuses: Status[];
  members: Member[];
}) {
  const statusName = (id: unknown) =>
    statuses.find((s) => s.id === id)?.name ?? (id ? "another status" : "none");
  const memberName = (id: unknown) => members.find((m) => m.id === id)?.name ?? "a teammate";

  const describe = () => {
    switch (entry.action) {
      case "created":
        return "created this task";
      case "commented":
        return "commented";
      case "assigned":
        return `assigned ${memberName(entry.changes[0]?.to)}`;
      case "unassigned":
        return `unassigned ${memberName(entry.changes[0]?.from ?? entry.changes[0]?.to)}`;
      case "tagged":
        return `added the tag ${String(entry.changes[0]?.to ?? "")}`;
      case "untagged":
        return "removed a tag";
      case "status_changed":
      case "updated": {
        const parts = entry.changes.map((c) =>
          c.field === "statusId"
            ? `moved ${statusName(c.from)} → ${statusName(c.to)}`
            : c.field === "assigneeIds"
              ? "changed assignees"
              : `set ${FIELD_LABEL[c.field] ?? c.field}: ${fmtValue(c.field, c.from)} → ${fmtValue(c.field, c.to)}`,
        );
        return parts.length ? parts.join(", ") : "updated this task";
      }
      case "archived":
        return "archived this task";
      case "linked":
        return "linked another task";
      case "unlinked":
        return "removed a link";
      case "added_to_cycle":
        return `added this to ${String(entry.changes[0]?.to ?? "a cycle")}`;
      case "removed_from_cycle":
        return "removed this from its cycle";
      case "completed": {
        const c = entry.changes.find((x) => x.field === "statusId");
        return c ? `marked this complete (${statusName(c.from)} → ${statusName(c.to)})` : "marked this complete";
      }
      default:
        return entry.changes.length
          ? entry.changes
              .map((c) =>
                c.field === "statusId"
                  ? `moved ${statusName(c.from)} → ${statusName(c.to)}`
                  : `changed ${FIELD_LABEL[c.field] ?? c.field} from ${fmt(c.from)} to ${fmt(c.to)}`,
              )
              .join(", ")
          : entry.action.replace(/_/g, " ");
    }
  };

  const when = new Date(entry.createdAt);
  return (
    <li className="flex gap-2 text-sm">
      <ActivityIcon entry={entry} />
      <p className="text-slate-600">
        <span className="font-medium text-slate-800">
          {entry.actor?.name ?? "Someone"}
        </span>{" "}
        {describe()}
        <span className="ml-1.5 text-xs text-muted-foreground" title={when.toLocaleString()}>
          {relativeTime(entry.createdAt)}
        </span>
      </p>
    </li>
  );
}

/** Small glyph per event type so the timeline can be scanned for "why did this slip". */
function ActivityIcon({ entry }: { entry: ActivityEntry }) {
  const fields = entry.changes.map((c) => c.field);
  const cls = "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]";
  if (entry.action === "completed") return <span className={`${cls} bg-green-100 text-green-700`}>✓</span>;
  if (entry.action === "status_changed" || fields.includes("statusId")) return <span className={`${cls} bg-blue-100 text-blue-700`}>↔</span>;
  if (entry.action === "assigned" || entry.action === "unassigned") return <span className={`${cls} bg-indigo-100 text-indigo-700`}>@</span>;
  if (fields.includes("dueDate") || fields.includes("startDate")) return <span className={`${cls} bg-amber-100 text-amber-700`}>📅</span>;
  if (fields.includes("timeEstimateMinutes")) return <span className={`${cls} bg-purple-100 text-purple-700`}>⏱</span>;
  if (entry.action === "commented") return <span className={`${cls} bg-slate-100 text-slate-600`}>💬</span>;
  return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />;
}

function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-muted"
        title="Add reaction"
      >
        ☺ +
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 flex gap-1 rounded-md border border-border bg-white p-1.5 shadow-lg">
          {QUICK_EMOJI.map((e) => (
            <button
              key={e}
              onClick={() => {
                onPick(e);
                setOpen(false);
              }}
              className="rounded px-1.5 py-0.5 text-base transition hover:bg-muted"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Picks another task in the same list and the kind of link to create. */
function AddRelation({ taskId, listId }: { taskId: string; listId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [relation, setRelation] = useState<RelationKind>("blocks");

  const { data: candidates = [] } = useQuery({
    queryKey: ["tasks", listId],
    queryFn: () => api.listTasks(listId),
    enabled: open,
  });

  const link = useMutation({
    mutationFn: (relatedTaskId: string) =>
      api.addRelation(taskId, relatedTaskId, relation),
    onSuccess: (next) => {
      qc.setQueryData(["relations", taskId], next);
      setOpen(false);
    },
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        + Link
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-border bg-white p-2 shadow-lg">
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value as RelationKind)}
            className="mb-1.5 w-full rounded border border-border px-2 py-1 text-xs"
          >
            {(Object.keys(RELATION_LABEL) as RelationKind[]).map((k) => (
              <option key={k} value={k}>
                {RELATION_LABEL[k]}
              </option>
            ))}
          </select>
          <div className="max-h-48 overflow-y-auto">
            {candidates
              .filter((t) => t.id !== taskId)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => link.mutate(t.id)}
                  className="block w-full truncate rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-muted"
                >
                  {t.title}
                </button>
              ))}
            {!candidates.filter((t) => t.id !== taskId).length && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                No other tasks in this list.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The text after a trailing "@", lower-cased — or null when not mentioning. */
function mentionToken(text: string): string | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

function fmt(v: unknown) {
  if (v === null || v === undefined || v === "") return "empty";
  const s = String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

export function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
