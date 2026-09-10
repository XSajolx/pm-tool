import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Member, type Priority, type Status } from "../lib/api.js";
import { Avatar, PRIORITY } from "./ui.js";
import { TaskCollaboration } from "./TaskCollaboration.js";
import { CycleField, SubtasksSection, TagsField, TrackTimeButton } from "./TaskExtras.js";

interface Props {
  taskId: string;
  listId: string;
  spaceId?: string;
  statuses: Status[];
  members: Member[];
  onClose: () => void;
}

export function TaskDetail({ taskId, listId, spaceId, statuses, members, onClose }: Props) {
  const qc = useQueryClient();
  const { data: task } = useQuery({ queryKey: ["task", taskId], queryFn: () => api.getTask(taskId) });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["task", taskId] });
    qc.invalidateQueries({ queryKey: ["tasks", listId] });
  };
  const addAssignee = useMutation({
    mutationFn: (userId: string) => api.addAssignee(taskId, userId),
    onSuccess: invalidate,
  });
  const removeAssignee = useMutation({
    mutationFn: (userId: string) => api.removeAssignee(taskId, userId),
    onSuccess: invalidate,
  });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? "");
    }
  }, [task]);

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateTask>[1]) => api.updateTask(taskId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", taskId] });
      qc.invalidateQueries({ queryKey: ["tasks", listId] });
    },
  });

  return (
    <>
      {/* backdrop */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      {/* panel */}
      <aside className="fixed right-0 top-0 z-50 flex h-screen w-[440px] flex-col border-l border-border bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            {task?.reference}
            {spaceId && <TrackTimeButton taskId={taskId} spaceId={spaceId} />}
          </span>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-muted">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        </header>

        {!task ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* Title */}
            <div className="px-5 pb-2 pt-4">
              <textarea
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title !== task.title && save.mutate({ title })}
                rows={1}
                className="w-full resize-none text-lg font-semibold text-slate-900 outline-none"
              />
            </div>

            {/* Field grid */}
            <div className="space-y-3 px-5 py-3">
              <Field label="Status">
                <select
                  value={task.statusId ?? ""}
                  onChange={(e) => save.mutate({ statusId: e.target.value })}
                  className="rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
                >
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Priority">
                <select
                  value={task.priority ?? ""}
                  onChange={(e) => save.mutate({ priority: e.target.value as Priority })}
                  className="rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
                >
                  <option value="">None</option>
                  {(Object.keys(PRIORITY) as Priority[]).map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY[p].label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Due date">
                <input
                  type="date"
                  value={task.dueDate ? task.dueDate.slice(0, 10) : ""}
                  onChange={(e) =>
                    save.mutate({ dueDate: new Date(e.target.value).toISOString() })
                  }
                  className="rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
              </Field>

              <Field label="Assignees">
                <div className="flex flex-wrap items-center gap-1.5">
                  {task.assignees.map((a) => (
                    <span
                      key={a.user.id}
                      className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-0.5 pr-1.5 text-xs"
                    >
                      <Avatar user={a.user} size={18} />
                      {a.user.name.split(" ")[0]}
                      <button
                        onClick={() => removeAssignee.mutate(a.user.id)}
                        className="text-slate-400 hover:text-red-500"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {(() => {
                    const unassigned = members.filter(
                      (m) => !task.assignees.some((a) => a.user.id === m.id),
                    );
                    if (!unassigned.length) return null;
                    return (
                      <select
                        value=""
                        onChange={(e) => e.target.value && addAssignee.mutate(e.target.value)}
                        className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-slate-500 outline-none"
                      >
                        <option value="">+ Assign</option>
                        {unassigned.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    );
                  })()}
                </div>
              </Field>

              <TagsField task={task} spaceId={spaceId} />
              <CycleField task={task} spaceId={spaceId} />
            </div>

            {/* Description */}
            <div className="border-t border-border px-5 py-4">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Description
              </p>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => description !== (task.description ?? "") && save.mutate({ description })}
                placeholder="Add a description…"
                rows={4}
                className="w-full resize-none rounded-md border border-border p-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <SubtasksSection task={task} listId={listId} />

            {/* Reactions, following, links, comments and history */}
            <TaskCollaboration taskId={taskId} listId={listId} statuses={statuses} />
          </div>
        )}
        {save.isPending && (
          <div className="border-t border-border px-5 py-1.5 text-xs text-muted-foreground">
            saving…
          </div>
        )}
      </aside>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[90px_1fr] items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
