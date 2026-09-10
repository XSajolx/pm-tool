import { useMemo } from "react";
import type { Status, Task } from "../lib/api.js";
import { AvatarStack, PriorityFlag, StatusPill } from "../components/ui.js";

interface Props {
  tasks: Task[];
  statuses: Status[];
  onOpenTask: (id: string) => void;
}

/** ClickUp-style List view: tasks grouped under collapsible status headers. */
export function ListView({ tasks, statuses, onOpenTask }: Props) {
  const groups = useMemo(() => {
    const g = statuses.map((s) => ({ status: s, tasks: [] as Task[] }));
    const none = { status: null as Status | null, tasks: [] as Task[] };
    for (const t of tasks) {
      const grp = g.find((x) => x.status.id === t.statusId);
      (grp ?? none).tasks.push(t);
    }
    return none.tasks.length ? [none, ...g] : g;
  }, [tasks, statuses]);

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        {/* header row */}
        <div className="grid grid-cols-[1fr_130px_120px_110px] items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Name</span>
          <span>Assignee</span>
          <span>Due date</span>
          <span>Priority</span>
        </div>
        {groups.map((grp) => (
          <div key={grp.status?.id ?? "none"}>
            <div className="flex items-center gap-2 border-b border-border bg-white px-4 py-1.5">
              {grp.status ? (
                <StatusPill name={grp.status.name} color={grp.status.color} />
              ) : (
                <StatusPill name="No status" color="#cbd5e1" />
              )}
              <span className="text-xs text-muted-foreground">{grp.tasks.length}</span>
            </div>
            {grp.tasks.map((t) => (
              <button
                key={t.id}
                onClick={() => onOpenTask(t.id)}
                className="grid w-full grid-cols-[1fr_130px_120px_110px] items-center gap-2 border-b border-border px-4 py-2 text-left last:border-0 hover:bg-muted/40"
              >
                <span className="flex items-center gap-2 text-sm text-slate-800">
                  <span className="text-[11px] text-muted-foreground">{t.reference}</span>
                  {t.title}
                  {t.subtasks.length > 0 && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      {t.subtasks.length} subtask{t.subtasks.length > 1 ? "s" : ""}
                    </span>
                  )}
                </span>
                <span>
                  <AvatarStack users={t.assignees.map((a) => a.user)} />
                </span>
                <span className="text-xs text-slate-500">
                  {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : "—"}
                </span>
                <span>
                  <PriorityFlag priority={t.priority} />
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
