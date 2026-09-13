import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MyTask, type TaskPatch } from "../lib/api.js";
import { DueCell, PriorityCell } from "../components/InlineEditors.js";
import { StatusPill } from "../components/ui.js";
import { cn } from "../lib/utils.js";
import { startOfDay } from "../components/taskViewUtils.js";

type BucketKey = "overdue" | "today" | "week" | "later" | "undated";
const BUCKETS: { key: BucketKey; label: string; tone: string; hint: string }[] = [
  { key: "overdue", label: "Overdue", tone: "text-red-600", hint: "Past their due date" },
  { key: "today", label: "Today", tone: "text-indigo-700", hint: "Due today" },
  { key: "week", label: "This week", tone: "text-slate-800", hint: "Due in the next 7 days" },
  { key: "later", label: "Later", tone: "text-slate-700", hint: "Due after this week" },
  { key: "undated", label: "No due date", tone: "text-slate-500", hint: "Assigned, not scheduled" },
];

/**
 * My Work: everything assigned to the signed-in user across every project,
 * bucketed by due date so the day can start from one page. Tasks can be
 * checked off, rescheduled and re-prioritised here without opening them.
 */
export function MyWorkPage() {
  const qc = useQueryClient();
  const [showDone, setShowDone] = useState(false);
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["my-tasks", showDone],
    queryFn: () => api.getMyTasks(showDone),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["my-tasks"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const update = useMutation({
    mutationFn: ({ taskId, patch }: { taskId: string; patch: TaskPatch }) => api.updateTask(taskId, patch),
    onMutate: async ({ taskId, patch }) => {
      await qc.cancelQueries({ queryKey: ["my-tasks", showDone] });
      const prev = qc.getQueryData<MyTask[]>(["my-tasks", showDone]);
      qc.setQueryData<MyTask[]>(["my-tasks", showDone], (old = []) =>
        old.map((t) => (t.id === taskId ? { ...t, ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}), ...(patch.priority !== undefined ? { priority: patch.priority } : {}) } : t)),
      );
      return { prev };
    },
    onError: (_e, _v, c) => c?.prev && qc.setQueryData(["my-tasks", showDone], c.prev),
    onSettled: invalidate,
  });
  const complete = useMutation({
    mutationFn: ({ taskId, done }: { taskId: string; done: boolean }) => (done ? api.completeTask(taskId) : api.reopenTask(taskId)),
    onSuccess: invalidate,
  });

  const groups = useMemo(() => bucketByDue(tasks), [tasks]);
  const openCount = tasks.filter((t) => t.status?.category !== "done").length;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div>
          <h1 className="text-sm font-semibold text-slate-800">My Work</h1>
          <p className="text-xs text-muted-foreground">
            {openCount} open task{openCount === 1 ? "" : "s"} assigned to you across all projects
          </p>
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="accent-indigo-600" />
          Show completed
        </label>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tasks.length ? (
          groups.map((g) => (
            <section key={g.key} className="mb-6">
              <h2 className={cn("mb-2 flex items-baseline gap-2 text-sm font-semibold", g.tone)}>
                {g.label}
                <span className="text-xs font-normal text-muted-foreground">
                  {g.items.length} · {g.hint}
                </span>
              </h2>
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {g.items.map((t) => {
                  const done = t.status?.category === "done";
                  return (
                    <li
                      key={t.id}
                      className="grid grid-cols-[auto_minmax(0,1fr)_130px_110px_100px] items-center gap-3 border-b border-border px-4 py-2 last:border-b-0 hover:bg-muted/30"
                    >
                      <input
                        type="checkbox"
                        checked={done}
                        title={done ? "Reopen" : "Mark done"}
                        onChange={(e) => complete.mutate({ taskId: t.id, done: e.target.checked })}
                        className="h-4 w-4 cursor-pointer accent-indigo-600"
                      />
                      <div className="min-w-0">
                        <Link to="/t/$taskId" params={{ taskId: t.id }} className={cn("block truncate text-sm hover:text-indigo-700", done ? "text-slate-400 line-through" : "text-slate-800")}>
                          {t.reference && <span className="mr-1.5 text-[11px] text-muted-foreground">{t.reference}</span>}
                          {t.title}
                        </Link>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {t.list?.spaceName ? `${t.list.spaceName} › ` : ""}
                          {t.list ? (
                            <Link to="/l/$listId" params={{ listId: t.list.id }} className="hover:text-indigo-700">
                              {t.list.name}
                            </Link>
                          ) : (
                            "No list"
                          )}
                          {t.stage ? ` · ${t.stage.name}` : ""}
                        </p>
                      </div>
                      <span>{t.status ? <StatusPill name={t.status.name} color={t.status.color} /> : <span className="text-xs text-muted-foreground">—</span>}</span>
                      <span>
                        <PriorityCell task={t} onUpdate={(id, patch) => update.mutate({ taskId: id, patch })} />
                      </span>
                      <span>
                        <DueCell task={t} onUpdate={(id, patch) => update.mutate({ taskId: id, patch })} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">🎉</span>
            <p className="text-sm text-muted-foreground">Nothing is assigned to you right now.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function bucketByDue(tasks: MyTask[]) {
  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const week = new Date(today);
  week.setDate(week.getDate() + 7);
  const items: Record<BucketKey, MyTask[]> = { overdue: [], today: [], week: [], later: [], undated: [] };
  for (const t of tasks) {
    if (!t.dueDate) {
      items.undated.push(t);
      continue;
    }
    // Due dates are stored at UTC midnight; compare on the calendar day.
    const d = startOfDay(new Date(t.dueDate.slice(0, 10) + "T00:00:00"));
    if (d < today) items.overdue.push(t);
    else if (d < tomorrow) items.today.push(t);
    else if (d < week) items.week.push(t);
    else items.later.push(t);
  }
  return BUCKETS.map((b) => ({ ...b, items: items[b.key] })).filter((b) => b.items.length);
}
