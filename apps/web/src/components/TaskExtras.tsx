import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, type Task, type TaskPatch } from "../lib/api.js";
import { AssigneeCell, DueCell } from "./InlineEditors.js";
import { useAuth } from "../lib/auth.js";
import { StatusPill } from "./ui.js";
import { cn } from "../lib/utils.js";

const TAG_COLORS = ["#6366f1", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#64748b"];

/**
 * Subtasks: one level deep. Each row has its own status (check-off), assignee
 * and due date; the heading shows done/total. A subtask can't have subtasks,
 * so the add form is hidden when this task is itself a subtask.
 */
export function SubtasksSection({ task, listId }: { task: Task; listId: string }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["task", task.id] });
    qc.invalidateQueries({ queryKey: ["tasks", listId] });
    qc.invalidateQueries({ queryKey: ["my-tasks"] });
  };
  const create = useMutation({
    mutationFn: () => api.createTask({ listId, title: title.trim(), parentTaskId: task.id }),
    onSuccess: () => {
      setTitle("");
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TaskPatch }) => api.updateTask(id, patch),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => (done ? api.completeTask(id) : api.reopenTask(id)),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteTask(id), onSuccess: refresh });
  const { role } = useAuth();
  const canDelete = role === "owner" || role === "admin";

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) create.mutate();
  }
  const done = task.subtasks.filter((s) => s.status?.category === "done").length;
  const isSubtask = Boolean(task.parentTaskId);

  return (
    <div className="border-t border-border px-5 py-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Subtasks {task.subtasks.length ? `(${done}/${task.subtasks.length})` : ""}
      </p>
      {task.subtasks.length ? (
        <ul className="mb-2 space-y-1">
          {task.subtasks.map((s) => {
            const isDone = s.status?.category === "done";
            // Inline editors expect a Task; a subtask row has the same shape for the fields they touch.
            const row = { ...s, id: s.id, title: s.title ?? "", assignees: s.assignees ?? [], dueDate: s.dueDate ?? null, priority: s.priority ?? null, status: s.status ?? null, subtasks: [] } as unknown as Task;
            return (
              <li key={s.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={isDone}
                  title={isDone ? "Reopen" : "Mark done"}
                  onChange={(e) => toggle.mutate({ id: s.id, done: e.target.checked })}
                  className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
                />
                <Link
                  to="/t/$taskId"
                  params={{ taskId: s.id }}
                  className={cn("min-w-0 flex-1 truncate hover:text-indigo-700", isDone ? "text-muted-foreground line-through" : "text-slate-700")}
                >
                  {s.title ?? "Subtask"}
                </Link>
                <AssigneeCell task={row} members={members} onUpdate={(id, patch) => update.mutate({ id, patch })} />
                <DueCell task={row} onUpdate={(id, patch) => update.mutate({ id, patch })} />
                <span className="shrink-0">{s.status && <StatusPill name={s.status.name} color={s.status.color} />}</span>
                {canDelete && (
                  <button type="button" onClick={() => remove.mutate(s.id)} title="Delete subtask" className="text-slate-300 hover:text-red-500">
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {isSubtask ? (
        <p className="text-xs text-muted-foreground">Subtasks go one level deep, so this subtask can't have its own.</p>
      ) : (
        <form onSubmit={submit} className="flex gap-1.5">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a subtask…" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm outline-none focus:border-indigo-500" />
          <button type="submit" disabled={!title.trim() || create.isPending} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">Add</button>
        </form>
      )}
    </div>
  );
}

/** Labels on the task, drawn from the space's tag set; new ones can be made inline. */
export function TagsField({ task }: { task: Task; spaceId?: string }) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const { data: all = [] } = useQuery({ queryKey: ["tags"], queryFn: () => api.getTags() });
  const spaceId = "workspace";
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["task", task.id] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const add = useMutation({ mutationFn: (tagId: string) => api.addTaskTag(task.id, tagId), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (tagId: string) => api.removeTaskTag(task.id, tagId), onSuccess: refresh });
  const create = useMutation({
    mutationFn: () => api.createTag({ name: newName.trim(), color: TAG_COLORS[newName.length % TAG_COLORS.length] }),
    onSuccess: (tag) => {
      setNewName("");
      qc.invalidateQueries({ queryKey: ["tags"] });
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

/** Stage picker: the stages of the project that owns this task's space. Hidden when the space has no project. */
export function StageField({ task, spaceId }: { task: Task; spaceId?: string }) {
  const qc = useQueryClient();
  const { data: stages = [] } = useQuery({
    queryKey: ["stages", "space", spaceId],
    queryFn: () => api.getStagesForSpace(spaceId!),
    enabled: Boolean(spaceId),
  });
  const set = useMutation({
    mutationFn: (stageId: string) => api.updateTask(task.id, { stageId: stageId || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", task.id] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["stages"] });
    },
  });
  if (!spaceId || !stages.length) return null;
  return (
    <div className="grid grid-cols-[90px_1fr] items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Stage</span>
      <select
        value={task.stageId ?? task.stage?.id ?? ""}
        onChange={(e) => set.mutate(e.target.value)}
        className="rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
      >
        <option value="">No stage</option>
        {stages.map((st) => (
          <option key={st.id} value={st.id}>
            {st.name}
            {st.status === "completed" ? " ✓" : st.status === "active" ? " ●" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Milestone picker: milestones of the project that owns this task's space. */
export function MilestoneField({ task, spaceId }: { task: Task; spaceId?: string }) {
  const qc = useQueryClient();
  const { data: milestones = [] } = useQuery({
    queryKey: ["milestones", "space", spaceId],
    queryFn: () => api.getMilestonesForSpace(spaceId!),
    enabled: Boolean(spaceId),
  });
  const set = useMutation({
    mutationFn: (milestoneId: string) => api.updateTask(task.id, { milestoneId: milestoneId || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", task.id] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["milestones"] });
    },
  });
  if (!spaceId || !milestones.length) return null;
  return (
    <div className="grid grid-cols-[90px_1fr] items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Milestone</span>
      <select
        value={task.milestoneId ?? task.milestone?.id ?? ""}
        onChange={(e) => set.mutate(e.target.value)}
        className="rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
      >
        <option value="">No milestone</option>
        {milestones.map((m) => (
          <option key={m.id} value={m.id}>
            {m.reachedAt ? "✓ " : ""}
            {m.name}
            {m.targetDate ? ` · ${new Date(m.targetDate).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Row 38: attach the task to a client, contact and/or deal. Picking a deal
 * fills in its company; picking a contact fills in theirs. The company name
 * links to the client's page, where the task shows under "Tasks".
 */
export function CrmLinkField({ task }: { task: Task }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: companies = [] } = useQuery({ queryKey: ["companies"], queryFn: () => api.getCompanies(), enabled: open });
  const companyId = task.companyId ?? task.company?.id ?? "";
  const { data: contacts = [] } = useQuery({
    queryKey: ["contacts", { companyId }],
    queryFn: () => api.getContacts(companyId ? { companyId } : {}),
    enabled: open,
  });
  const { data: deals = [] } = useQuery({ queryKey: ["deals"], queryFn: api.getDeals, enabled: open });
  const set = useMutation({
    mutationFn: (patch: TaskPatch) => api.updateTask(task.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", task.id] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["crm-tasks"] });
    },
  });
  const linked = task.company || task.contact || task.deal;
  const sel = "w-full rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30";
  const visibleDeals = companyId ? deals.filter((d) => d.company?.id === companyId || d.id === task.dealId) : deals;

  return (
    <div className="grid grid-cols-[90px_1fr] items-start gap-2">
      <span className="pt-1 text-xs font-medium text-muted-foreground">Client</span>
      <div className="space-y-1.5">
        {!open && (
          <div className="flex flex-wrap items-center gap-1.5">
            {task.company && (
              <Link to="/crm/companies/$companyId" params={{ companyId: task.company.id }} className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100">
                🏢 {task.company.name}
              </Link>
            )}
            {task.contact && (
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-slate-700">
                👤 {[task.contact.firstName, task.contact.lastName].filter(Boolean).join(" ")}
              </span>
            )}
            {task.deal && (
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700" title={`Deal · ${task.deal.stage?.name ?? ""}`}>
                💼 {task.deal.title}
              </span>
            )}
            <button type="button" onClick={() => setOpen(true)} className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-slate-500 hover:bg-muted">
              {linked ? "Change" : "+ Link to client, contact or deal"}
            </button>
          </div>
        )}
        {open && (
          <div className="space-y-1.5 rounded-md border border-border bg-[#fbfbfa] p-2">
            <select
              value={companyId}
              onChange={(e) => set.mutate({ companyId: e.target.value || null, contactId: null, dealId: null })}
              className={sel}
              aria-label="Company"
            >
              <option value="">No company</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={task.contactId ?? task.contact?.id ?? ""} onChange={(e) => set.mutate({ contactId: e.target.value || null })} className={sel} aria-label="Contact">
              <option value="">No contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                  {c.company && !companyId ? ` · ${c.company.name}` : ""}
                </option>
              ))}
            </select>
            <select value={task.dealId ?? task.deal?.id ?? ""} onChange={(e) => set.mutate({ dealId: e.target.value || null })} className={sel} aria-label="Deal">
              <option value="">No deal</option>
              {visibleDeals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                  {d.company && !companyId ? ` · ${d.company.name}` : ""}
                </option>
              ))}
            </select>
            <div className="flex justify-end">
              <button type="button" onClick={() => setOpen(false)} className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
