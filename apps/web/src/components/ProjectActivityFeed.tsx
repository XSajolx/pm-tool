import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type ProjectActivity, type ProjectActivityEntry } from "../lib/api.js";
import { Avatar } from "../components/ui.js";
import { relativeTime } from "./TaskCollaboration.js";
import { cn } from "../lib/utils.js";

/**
 * Row 102: what changed on the project - tasks created / moved / assigned,
 * status changes, comments, doc edits, milestones, stages and team changes -
 * in one list, filterable by kind, so nobody has to reconstruct the week.
 */
type Kind = "all" | "task" | "comment" | "document" | "milestone" | "stage" | "team";
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "task", label: "Tasks" },
  { id: "comment", label: "Comments" },
  { id: "document", label: "Docs" },
  { id: "milestone", label: "Milestones" },
  { id: "stage", label: "Stages" },
  { id: "team", label: "Team & details" },
];

const FIELD_LABEL: Record<string, string> = {
  statusId: "status",
  priority: "priority",
  dueDate: "due date",
  startDate: "start date",
  title: "title",
  timeEstimateMinutes: "estimate",
  description: "description",
  listId: "list",
  stageId: "stage",
  milestoneId: "milestone",
  targetDate: "target date",
  name: "name",
  status: "status",
  leadId: "project lead",
  budgetHours: "budget hours",
  budgetAmount: "budget",
  endDate: "target date",
  clientName: "client",
  memberRole: "role",
};

function kindOf(e: ProjectActivityEntry): Kind {
  if (e.entityType === "task") return e.action === "commented" ? "comment" : "task";
  if (e.entityType === "document") return "document";
  if (e.entityType === "milestone") return "milestone";
  if (e.entityType === "stage") return "stage";
  return "team";
}

function fmtVal(field: string, v: unknown, data: ProjectActivity) {
  if (v == null || v === "") return "none";
  if (field === "statusId") return data.statuses[String(v)] ?? "another status";
  if (["member", "leadId", "assigneeId"].includes(field)) return data.users[String(v)] ?? "a teammate";
  if (/date/i.test(field) && typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (field === "timeEstimateMinutes" && typeof v === "number") return `${Math.round((v / 60) * 10) / 10}h`;
  return String(v);
}

export function describe(e: ProjectActivityEntry, data: ProjectActivity): string {
  const c0 = e.changes[0];
  const user = (v: unknown) => data.users[String(v)] ?? "a teammate";
  const diffs = () =>
    e.changes
      .map((c) => (c.field === "statusId" ? `moved ${fmtVal("statusId", c.from, data)} → ${fmtVal("statusId", c.to, data)}` : `set ${FIELD_LABEL[c.field] ?? c.field}: ${fmtVal(c.field, c.from, data)} → ${fmtVal(c.field, c.to, data)}`))
      .join(", ");
  switch (e.entityType) {
    case "task":
      switch (e.action) {
        case "created": return "created the task";
        case "commented": return "commented on";
        case "assigned": return `assigned ${user(c0?.to)} to`;
        case "unassigned": return `unassigned ${user(c0?.from ?? c0?.to)} from`;
        case "completed": return "completed";
        case "status_changed": return diffs() || "changed the status of";
        case "moved": return "moved";
        case "archived": return "archived";
        case "recurred": return "created the next occurrence of";
        case "tagged": return `tagged ${String(c0?.to ?? "")} on`;
        case "untagged": return "removed a tag from";
        case "linked": return "linked";
        case "unlinked": return "unlinked";
        case "updated": return e.changes.length ? `${diffs()} on` : "updated";
        default: return e.action.replace(/_/g, " ");
      }
    case "document":
      switch (e.action) {
        case "created": return "created the doc";
        case "commented": return "commented on the doc";
        case "edited": return c0?.field === "title" ? `renamed the doc to “${String(c0.to)}” from` : "edited the doc";
        case "review_requested": return "sent for review the doc";
        case "approved": return "approved the doc";
        case "rejected": return "sent back the doc";
        default: return `${e.action.replace(/_/g, " ")} the doc`;
      }
    case "milestone":
      switch (e.action) {
        case "created": return "added the milestone";
        case "reached": return "reached the milestone";
        case "unreached": return "reopened the milestone";
        case "signoff_requested": return "requested sign-off on";
        case "deleted": return "removed the milestone";
        case "updated": return e.changes.length ? `${diffs()} on the milestone` : "updated the milestone";
        default: return `${e.action.replace(/_/g, " ")} the milestone`;
      }
    case "stage":
      switch (e.action) {
        case "created": return "added the stage";
        case "renamed": return "renamed the stage";
        case "started": return "started the stage";
        case "completed": return "completed the stage";
        case "deleted": return "removed the stage";
        default: return e.changes.length ? `${diffs()} on the stage` : `${e.action.replace(/_/g, " ")} the stage`;
      }
    default: {
      if (e.action === "project_created") return "created the project";
      if (c0?.field === "member") return c0.to ? `added ${user(c0.to)} to the team` : `removed ${user(c0.from)} from the team`;
      if (c0?.field === "memberRole") return `made ${user(c0.from)} a ${String(c0.to)}`;
      return e.changes.length ? diffs() : e.action.replace(/_/g, " ");
    }
  }
}

function ICON(kind: Kind) {
  return { all: "•", task: "☐", comment: "💬", document: "📄", milestone: "◆", stage: "▸", team: "👥" }[kind];
}

function entityLink(e: ProjectActivityEntry) {
  if (!e.entity.label) return null;
  if (e.entityType === "task") return <Link to="/t/$taskId" params={{ taskId: e.entityId }} className="font-medium text-slate-800 hover:text-indigo-700">{e.entity.label}</Link>;
  if (e.entityType === "document") return <Link to="/docs/$docId" params={{ docId: e.entityId }} className="font-medium text-slate-800 hover:text-indigo-700">{e.entity.label}</Link>;
  return <span className="font-medium text-slate-800">{e.entity.label}</span>;
}

export function ProjectActivityFeed({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<Kind>("all");
  const [shown, setShown] = useState(40);
  const { data, isLoading } = useQuery({ queryKey: ["project-activity", projectId], queryFn: () => api.getProjectActivity(projectId), refetchInterval: 60_000 });

  const rows = useMemo(() => {
    const all = data?.entries ?? [];
    return kind === "all" ? all : all.filter((e) => kindOf(e) === kind);
  }, [data, kind]);
  const counts = useMemo(() => {
    const c: Record<Kind, number> = { all: 0, task: 0, comment: 0, document: 0, milestone: 0, stage: 0, team: 0 };
    for (const e of data?.entries ?? []) { c.all++; c[kindOf(e)]++; }
    return c;
  }, [data]);

  // Group by day so the list reads as a diary.
  const groups = useMemo(() => {
    const out: { day: string; items: ProjectActivityEntry[] }[] = [];
    for (const e of rows.slice(0, shown)) {
      const day = new Date(e.createdAt).toDateString();
      const g = out[out.length - 1];
      if (g && g.day === day) g.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [rows, shown]);

  const dayLabel = (d: string) => {
    const today = new Date().toDateString();
    const y = new Date(Date.now() - 86_400_000).toDateString();
    return d === today ? "Today" : d === y ? "Yesterday" : new Date(d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };

  return (
    <section className="mt-6 rounded-lg border border-border bg-white" data-testid="project-activity">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</h2>
        <div className="ml-2 flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => { setKind(k.id); setShown(40); }}
              className={cn("rounded-full border px-2 py-0.5 text-[11px]", kind === k.id ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:border-slate-300")}
            >
              {k.label}
              {counts[k.id] ? <span className="ml-1 text-muted-foreground">{counts[k.id]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !rows.length ? (
          <p className="text-sm text-muted-foreground">Nothing here yet.</p>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.day} className="mb-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{dayLabel(g.day)}</p>
                <ul className="space-y-1.5">
                  {g.items.map((e) => (
                    <li key={e.id} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 w-4 shrink-0 text-center text-xs text-muted-foreground" title={kindOf(e)}>{ICON(kindOf(e))}</span>
                      {e.actor ? <Avatar user={{ id: e.actor.id, name: e.actor.name, avatarUrl: e.actor.avatarUrl, email: "", role: "member" }} size={18} /> : <span className="h-[18px] w-[18px] rounded-full bg-slate-200" />}
                      <p className="min-w-0 flex-1 text-slate-600">
                        <span className="font-medium text-slate-800">{e.actor?.name ?? "System"}</span> {describe(e, data!)} {entityLink(e)}
                        <span className="ml-1.5 text-xs text-muted-foreground" title={new Date(e.createdAt).toLocaleString()}>{relativeTime(e.createdAt)}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {rows.length > shown && (
              <button type="button" onClick={() => setShown((n) => n + 40)} className="text-xs text-indigo-700 hover:underline">
                Show {Math.min(40, rows.length - shown)} more
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
