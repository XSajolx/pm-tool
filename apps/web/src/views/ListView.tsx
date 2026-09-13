import { useMemo, useState } from "react";
import type { Member, Status, Task } from "../lib/api.js";
import { StatusPill } from "../components/ui.js";
import { AssigneeCell, DueCell, PriorityCell, StatusCell, type UpdateTask } from "../components/InlineEditors.js";
import { groupTasks, sortTasks, type GroupBy, type SortDir, type SortKey } from "../components/taskViewUtils.js";

interface Props {
  tasks: Task[];
  statuses: Status[];
  members: Member[];
  groupBy: GroupBy;
  sort: SortKey;
  sortDir: SortDir;
  onOpenTask: (id: string) => void;
  onUpdate: UpdateTask;
}

/**
 * ClickUp-style List view: tasks under collapsible group headers (status by
 * default), sortable, with inline edits for status, assignee, due date and
 * priority. Clicking the row itself opens the task panel.
 */
export function ListView({ tasks, statuses, members, groupBy, sort, sortDir, onOpenTask, onUpdate }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const sorted = sortTasks(tasks, sort, sortDir, statuses);
    return groupTasks(sorted, groupBy, statuses, members);
  }, [tasks, statuses, members, groupBy, sort, sortDir]);

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <div className="grid grid-cols-[1fr_130px_130px_120px_110px] items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Name</span>
          <span>Status</span>
          <span>Assignee</span>
          <span>Due date</span>
          <span>Priority</span>
        </div>
        {groups.map((grp) => {
          const isCollapsed = collapsed[grp.key];
          return (
            <div key={grp.key}>
              {groupBy !== "none" && (
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [grp.key]: !c[grp.key] }))}
                  className="flex w-full items-center gap-2 border-b border-border bg-white px-4 py-1.5 text-left hover:bg-muted/30"
                >
                  <span className="w-3 text-[10px] text-slate-400">{isCollapsed ? "▸" : "▾"}</span>
                  <StatusPill name={grp.label} color={grp.color} />
                  <span className="text-xs text-muted-foreground">{grp.tasks.length}</span>
                </button>
              )}
              {!isCollapsed &&
                grp.tasks.map((t) => (
                  <div
                    key={`${grp.key}:${t.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenTask(t.id)}
                    onKeyDown={(e) => e.key === "Enter" && onOpenTask(t.id)}
                    className="grid w-full cursor-pointer grid-cols-[1fr_130px_130px_120px_110px] items-center gap-2 border-b border-border px-4 py-2 text-left last:border-0 hover:bg-muted/40"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm text-slate-800">
                      {t.reference && <span className="text-[11px] text-muted-foreground">{t.reference}</span>}
                      <span className={`truncate ${t.status?.category === "done" ? "text-slate-400 line-through" : ""}`}>{t.title}</span>
                      {t.subtasks.length > 0 && (
                        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                          {t.subtasks.filter((s) => s.status?.category === "done").length}/{t.subtasks.length}
                        </span>
                      )}
                      {t.tags?.map((tag) => (
                        <span key={tag.id} className="shrink-0 rounded-full px-1.5 text-[10px] font-medium" style={{ background: `${tag.color}22`, color: tag.color }}>
                          {tag.name}
                        </span>
                      ))}
                    </span>
                    <span>
                      <StatusCell task={t} statuses={statuses} onUpdate={onUpdate} />
                    </span>
                    <span>
                      <AssigneeCell task={t} members={members} onUpdate={onUpdate} />
                    </span>
                    <span>
                      <DueCell task={t} onUpdate={onUpdate} />
                    </span>
                    <span>
                      <PriorityCell task={t} onUpdate={onUpdate} />
                    </span>
                  </div>
                ))}
              {!isCollapsed && grp.tasks.length === 0 && (
                <p className="border-b border-border px-9 py-2 text-xs text-muted-foreground last:border-0">No tasks</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
