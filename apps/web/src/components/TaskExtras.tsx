import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Task } from "../lib/api.js";
import { StatusPill } from "./ui.js";
import { cn } from "../lib/utils.js";

const TAG_COLORS = ["#6366f1", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#64748b"];

/** Subtasks: a list with inline add. Creating one uses the same list as the parent. */
export function SubtasksSection({ task, listId }: { task: Task; listId: string }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const create = useMutation({
    mutationFn: () => api.createTask({ listId, title: title.trim(), parentTaskId: task.id } as Parameters<typeof api.createTask>[0] & { parentTaskId: string }),
    onSuccess: () => {
      setTitle("");
      qc.invalidateQueries({ queryKey: ["task", task.id] });
      qc.invalidateQueries({ queryKey: ["tasks", listId] });
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) create.mutate();
  }
  const done = task.subtasks.filter((s) => s.status?.category === "done").length;

  return (
    <div className="border-t border-border px-5 py-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Subtasks {task.subtasks.length ? `(${done}/${task.subtasks.length})` : ""}
      </p>
      {task.subtasks.length ? (
        <ul className="mb-2 space-y-1">
          {task.subtasks.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
              <span className={cn("truncate", s.status?.category === "done" ? "text-muted-foreground line-through" : "text-slate-700")}>{s.title ?? "Subtask"}</span>
              <span className="ml-auto shrink-0">{s.status && <StatusPill name={s.status.name} color={s.status.color} />}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={submit} className="flex gap-1.5">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a subtask…" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm outline-none focus:border-indigo-500" />
        <button type="submit" disabled={!title.trim() || create.isPending} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">Add</button>
      </form>
    </div>
  );
}

/** Labels on the task, drawn from the space's tag set; new ones can be made inline. */
export function TagsField({ task, spaceId }: { task: Task; spaceId?: string }) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const { data: all = [] } = useQuery({ queryKey: ["tags", spaceId], queryFn: () => api.getTags(spaceId!), enabled: Boolean(spaceId) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["task", task.id] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const add = useMutation({ mutationFn: (tagId: string) => api.addTaskTag(task.id, tagId), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (tagId: string) => api.removeTaskTag(task.id, tagId), onSuccess: refresh });
  const create = useMutation({
    mutationFn: () => api.createTag(spaceId!, { name: newName.trim(), color: TAG_COLORS[newName.length % TAG_COLORS.length] }),
    onSuccess: (tag) => {
      setNewName("");
      qc.invalidateQueries({ queryKey: ["tags", spaceId] });
      add.mutate(tag.id);
    },
  });

  const mine = task.tags ?? [];
  const available = all.filter((t) => !mine.some((m) => m.id === t.id));

  return (
    <div className="grid grid-cols-[90px_1fr] items-start gap-2">
      <span className="pt-1 text-xs font-medium text-muted-foreground">Tags</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {mine.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${t.color}1a`, color: t.color }}>
            {t.name}
            <button onClick={() => remove.mutate(t.id)} className="opacity-60 hover:opacity-100">×</button>
          </span>
        ))}
        {spaceId && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value === "__new") return;
              if (e.target.value) add.mutate(e.target.value);
            }}
            className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-slate-500 outline-none"
          >
            <option value="">+ Tag</option>
            {available.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        {spaceId && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) create.mutate();
            }}
            className="flex"
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new tag…" className="w-20 rounded-full border border-border px-2 py-0.5 text-xs outline-none focus:border-indigo-500" />
          </form>
        )}
      </div>
    </div>
  );
}

/** Which cycle (sprint) the task is in, if any. */
export function CycleField({ task, spaceId }: { task: Task; spaceId?: string }) {
  const qc = useQueryClient();
  const { data: cycles = [] } = useQuery({ queryKey: ["cycles", spaceId], queryFn: () => api.getCycles(spaceId!), enabled: Boolean(spaceId) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["task", task.id] });
    qc.invalidateQueries({ queryKey: ["cycles", spaceId] });
  };
  const set = useMutation({
    mutationFn: (cycleId: string) => (cycleId ? api.addTaskToCycle(cycleId, task.id) : api.removeTaskFromCycle(task.id)),
    onSuccess: refresh,
  });
  if (!spaceId) return null;
  return (
    <div className="grid grid-cols-[90px_1fr] items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Cycle</span>
      <select value={task.cycleId ?? ""} onChange={(e) => set.mutate(e.target.value)} className="rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30">
        <option value="">No cycle</option>
        {cycles.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.state})</option>)}
      </select>
    </div>
  );
}

/** Starts the timer on this task's project, attributed to this task. */
export function TrackTimeButton({ taskId, spaceId }: { taskId: string; spaceId: string }) {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });
  const { data: running } = useQuery({ queryKey: ["timer"], queryFn: api.getRunningTimer });
  const project = projects.find((p) => p.spaceId === spaceId);
  const start = useMutation({
    mutationFn: () => api.startTimer({ projectId: project!.id, taskId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["timer"] }),
  });
  if (!project) return null;
  const onThis = running?.taskId === taskId;
  return (
    <button
      onClick={() => !onThis && start.mutate()}
      disabled={onThis || start.isPending}
      title={onThis ? "Timer running on this task" : `Track time on ${project.name}`}
      className={cn("rounded-md px-2 py-1 text-xs font-medium transition", onThis ? "bg-indigo-50 text-indigo-700" : "border border-border text-slate-600 hover:bg-muted")}
    >
      {onThis ? "● Tracking" : "▶ Track time"}
    </button>
  );
}
