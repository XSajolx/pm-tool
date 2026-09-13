import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Member, type Priority, type Status } from "../lib/api.js";
import { Avatar, PRIORITY } from "./ui.js";
import { TaskCollaboration } from "./TaskCollaboration.js";
import { CycleField, MilestoneField, StageField, SubtasksSection, TagsField, TrackTimeButton } from "./TaskExtras.js";
import { useEscape } from "../lib/useEscape.js";
import { useAuth } from "../lib/auth.js";

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
  const { role } = useAuth();
  const canDelete = role === "owner" || role === "admin";
  useEscape(onClose);

  // Archive, not hard delete: the row keeps its history and can be restored later.
  const remove = useMutation({
    mutationFn: () => api.deleteTask(taskId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", listId] });
      qc.invalidateQueries({ queryKey: ["space-overview"] });
      onClose();
    },
  });
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
          {canDelete && (
            <button
              onClick={() => window.confirm("Delete this task? It will be archived and disappear from the list.") && remove.mutate()}
              disabled={remove.isPending}
              className="mr-1 rounded px-2 py-1 text-xs text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              Delete
            </button>
          )}
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

              <Field label="Start date">
                <DateInput
                  value={task.startDate}
                  onChange={(iso) => save.mutate({ startDate: iso })}
                />
              </Field>

              <Field label="Due date">
                <DateInput
                  value={task.dueDate}
                  onChange={(iso) => save.mutate({ dueDate: iso })}
                />
              </Field>

              <Field label="Repeat">
                <RepeatField
                  recurrence={task.recurrence ?? null}
                  interval={task.recurrenceInterval ?? 1}
                  isSubtask={Boolean(task.parentTaskId)}
                  onChange={(recurrence, recurrenceInterval) => save.mutate({ recurrence, recurrenceInterval })}
                />
              </Field>

              <Field label="Estimate">
                <EstimateInput
                  minutes={task.timeEstimateMinutes}
                  onChange={(m) => save.mutate({ timeEstimateMinutes: m })}
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
              <StageField task={task} spaceId={spaceId} />
              <MilestoneField task={task} spaceId={spaceId} />
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

/** Date picker that can also clear the value (sends null). Dates are stored as UTC midnight. */
function DateInput({ value, onChange }: { value: string | null; onChange: (iso: string | null) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="date"
        value={value ? value.slice(0, 10) : ""}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value + "T00:00:00Z").toISOString() : null)}
        className="rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
      />
      {value && (
        <button type="button" onClick={() => onChange(null)} title="Clear" className="text-xs text-slate-400 hover:text-red-500">
          ✕
        </button>
      )}
    </div>
  );
}

/** Estimate typed as "2h", "90m", "1h 30m" or "1.5"; stored as whole minutes. */
export function EstimateInput({ minutes, onChange }: { minutes: number | null; onChange: (m: number | null) => void }) {
  const [text, setText] = useState(formatMinutes(minutes));
  useEffect(() => setText(formatMinutes(minutes)), [minutes]);
  const commit = () => {
    const parsed = parseEstimate(text);
    if (parsed === undefined) {
      setText(formatMinutes(minutes));
      return;
    }
    if (parsed !== minutes) onChange(parsed);
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      placeholder="e.g. 2h 30m"
      className="w-28 rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
    />
  );
}

export function formatMinutes(m: number | null | undefined): string {
  if (!m) return "";
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h && rest ? `${h}h ${rest}m` : h ? `${h}h` : `${rest}m`;
}

/** Returns null for empty, undefined for unparseable. */
export function parseEstimate(text: string): number | null | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * 60);
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|d|day|days)/g)) {
    matched = true;
    const n = parseFloat(m[1]!);
    const unit = m[2]!;
    total += unit.startsWith("d") ? n * 8 * 60 : unit.startsWith("h") ? n * 60 : n;
  }
  return matched ? Math.round(total) : undefined;
}

/** Repeat rule picker: none / every N days / weeks / months. Subtasks don't repeat on their own. */
function RepeatField({
  recurrence,
  interval,
  isSubtask,
  onChange,
}: {
  recurrence: "daily" | "weekly" | "monthly" | null;
  interval: number;
  isSubtask: boolean;
  onChange: (recurrence: "daily" | "weekly" | "monthly" | null, interval: number) => void;
}) {
  if (isSubtask) return <span className="text-xs text-muted-foreground">Subtasks follow their parent</span>;
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={recurrence ?? ""}
        onChange={(e) => onChange((e.target.value || null) as "daily" | "weekly" | "monthly" | null, interval)}
        className="rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
      >
        <option value="">Does not repeat</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      {recurrence && (
        <label className="flex items-center gap-1 text-xs text-slate-600">
          every
          <input
            type="number"
            min={1}
            max={365}
            value={interval}
            onChange={(e) => onChange(recurrence, Math.max(1, Number(e.target.value) || 1))}
            className="w-14 rounded-md border border-border px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
          {recurrence === "daily" ? "day(s)" : recurrence === "weekly" ? "week(s)" : "month(s)"}
        </label>
      )}
      {recurrence && <span className="text-[11px] text-muted-foreground" title="The next instance is created when this one is completed">↻ next on completion</span>}
    </div>
  );
}
