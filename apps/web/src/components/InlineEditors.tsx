/**
 * Compact editors used inside List and Table rows. Each one stops click
 * propagation so editing a cell never opens the task panel, and each renders
 * as plain text until hovered so rows stay scannable.
 */
import type { Member, Priority, Status, Task, TaskPatch } from "../lib/api.js";
import { Avatar, AvatarStack, PRIORITY, PriorityFlag, StatusPill } from "./ui.js";

export type UpdateTask = (taskId: string, patch: TaskPatch) => void;

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function StatusCell({ task, statuses, onUpdate }: { task: Task; statuses: Status[]; onUpdate: UpdateTask }) {
  return (
    <span className="relative inline-flex" onClick={stop}>
      {task.status ? (
        <StatusPill name={task.status.name} color={task.status.color} />
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
      <select
        value={task.statusId ?? ""}
        onChange={(e) => e.target.value && onUpdate(task.id, { statusId: e.target.value })}
        title="Change status"
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">—</option>
        {statuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </span>
  );
}

export function PriorityCell({ task, onUpdate }: { task: Task; onUpdate: UpdateTask }) {
  return (
    <span className="relative inline-flex" onClick={stop}>
      <PriorityFlag priority={task.priority} />
      <select
        value={task.priority ?? ""}
        onChange={(e) => onUpdate(task.id, { priority: (e.target.value || null) as Priority | null })}
        title="Change priority"
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">None</option>
        {(Object.keys(PRIORITY) as Priority[]).map((p) => (
          <option key={p} value={p}>
            {PRIORITY[p].label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function DueCell({ task, onUpdate }: { task: Task; onUpdate: UpdateTask }) {
  const overdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status?.category !== "done";
  return (
    <span className="relative inline-flex items-center" onClick={stop}>
      <span className={`text-xs ${overdue ? "font-medium text-red-600" : "text-slate-500"}`}>
        {task.dueDate ? new Date(task.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "—"}
      </span>
      <input
        type="date"
        value={task.dueDate ? task.dueDate.slice(0, 10) : ""}
        onChange={(e) => onUpdate(task.id, { dueDate: e.target.value ? `${e.target.value}T00:00:00.000Z` : null })}
        title="Change due date"
        className="absolute inset-0 w-full cursor-pointer opacity-0"
      />
    </span>
  );
}

export function AssigneeCell({ task, members, onUpdate }: { task: Task; members: Member[]; onUpdate: UpdateTask }) {
  const ids = task.assignees.map((a) => a.user.id);
  return (
    <span className="relative inline-flex min-h-[22px] min-w-[22px] items-center" onClick={stop}>
      {ids.length ? (
        <AvatarStack users={task.assignees.map((a) => a.user)} />
      ) : (
        <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border border-dashed border-border text-[10px] text-slate-400">
          +
        </span>
      )}
      <select
        value=""
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return;
          const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
          onUpdate(task.id, { assigneeIds: next });
        }}
        title="Assign"
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">Assign…</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {ids.includes(m.id) ? "✓ " : ""}
            {m.name}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Small avatar + name, for group headers. */
export function MemberChip({ member }: { member: Member }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700">
      <Avatar user={member} size={18} />
      {member.name}
    </span>
  );
}
