import { useEffect, useMemo, useState } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BulkTaskPatch, type Member, type Priority, type Status, type Tag, type Task, type TaskPatch, type SpaceTree } from "../lib/api.js";
import { Button, PRIORITY } from "../components/ui.js";
import { TaskDetail } from "../components/TaskDetail.js";
import { ViewsAndCycles } from "../components/ViewsAndCycles.js";
import { BoardView } from "./BoardView.js";
import { ListView } from "./ListView.js";
import { TableView } from "./TableView.js";
import { CalendarView } from "./CalendarView.js";
import { GROUP_OPTIONS, SORT_OPTIONS, type GroupBy, type SortDir, type SortKey } from "../components/taskViewUtils.js";
import { cn } from "../lib/utils.js";
import { recordRecent } from "../lib/recent.js";

type ViewKey = "list" | "board" | "table" | "calendar";
const VIEWS: { key: ViewKey; label: string; icon: string }[] = [
  { key: "list", label: "List", icon: "M4 6h16M4 12h16M4 18h10" },
  { key: "board", label: "Board", icon: "M4 4h6v16H4zM14 4h6v10h-6z" },
  { key: "table", label: "Table", icon: "M3 5h18v14H3zM3 10h18M9 5v14" },
  { key: "calendar", label: "Calendar", icon: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" },
];

/** Everything a saved view persists besides its layout. */
interface ViewSettings {
  priority?: string;
  assignee?: string;
  tag?: string;
  groupBy?: GroupBy;
  sort?: SortKey;
  sortDir?: SortDir;
}

export function WorkspacePage() {
  const { listId } = useParams({ from: "/l/$listId" });
  const qc = useQueryClient();
  // Deep links land here with ?task= (open the panel) and/or ?view= (layout).
  const search = useSearch({ strict: false }) as { task?: string; view?: ViewKey };
  const [view, setView] = useState<ViewKey>(search.view ?? "list");
  const [openTaskId, setOpenTaskId] = useState<string | null>(search.task ?? null);
  const [draft, setDraft] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [sort, setSort] = useState<SortKey>("manual");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => api.getTags() });

  const ctx = useMemo(() => {
    for (const s of spaces) {
      if (s.lists.some((l) => l.id === listId))
        return { space: s, listName: s.lists.find((l) => l.id === listId)!.name };
      for (const f of s.folders) {
        const l = f.lists.find((x) => x.id === listId);
        if (l) return { space: s, listName: l.name };
      }
    }
    return null;
  }, [spaces, listId]);

  const spaceId = ctx?.space.id;

  // Feed the space overview's "Recent" card.
  useEffect(() => {
    if (ctx) {
      recordRecent({ listId, listName: ctx.listName, spaceId: ctx.space.id, spaceName: ctx.space.name });
    }
  }, [ctx, listId]);

  const { data: statuses = [] } = useQuery({
    queryKey: ["statuses", spaceId],
    queryFn: () => api.getStatuses(spaceId!),
    enabled: Boolean(spaceId),
  });

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["tasks", listId],
    queryFn: () => api.listTasks(listId),
  });

  const createTask = useMutation({
    mutationFn: (title: string) => api.createTask({ listId, title, statusId: statuses[0]?.id }),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["tasks", listId] });
    },
  });

  // One optimistic PATCH for every view: board drags, calendar drags and inline
  // cell edits all go through here, so a change made in one layout is already
  // on screen when the user switches to another.
  const updateTask = useMutation({
    mutationFn: ({ taskId, patch }: { taskId: string; patch: TaskPatch }) => api.updateTask(taskId, patch),
    onMutate: async ({ taskId, patch }) => {
      await qc.cancelQueries({ queryKey: ["tasks", listId] });
      const prev = qc.getQueryData<Task[]>(["tasks", listId]);
      qc.setQueryData<Task[]>(["tasks", listId], (old = []) =>
        old.map((t) => {
          if (t.id !== taskId) return t;
          const next: Task = { ...t };
          if (patch.statusId !== undefined) {
            next.statusId = patch.statusId;
            next.status = statuses.find((s) => s.id === patch.statusId) ?? t.status;
          }
          if (patch.priority !== undefined) next.priority = patch.priority;
          if (patch.dueDate !== undefined) next.dueDate = patch.dueDate;
          if (patch.startDate !== undefined) next.startDate = patch.startDate;
          if (patch.title !== undefined) next.title = patch.title;
          if (patch.assigneeIds !== undefined) {
            next.assignees = patch.assigneeIds
              .map((id) => members.find((m) => m.id === id))
              .filter((m): m is NonNullable<typeof m> => Boolean(m))
              .map((user) => ({ user }));
          }
          return next;
        }),
      );
      return { prev };
    },
    onError: (_e, _v, c) => c?.prev && qc.setQueryData(["tasks", listId], c.prev),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["tasks", listId] });
      qc.invalidateQueries({ queryKey: ["my-tasks"] });
    },
  });
  const onUpdate = (taskId: string, patch: TaskPatch) => updateTask.mutate({ taskId, patch });

  const toggleSelect = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const bulk = useMutation({
    mutationFn: (patch: BulkTaskPatch) => api.bulkUpdateTasks([...selected], patch),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["my-tasks"] });
    },
  });

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
        if (tagFilter !== "all" && !(t.tags ?? []).some((tag) => tag.id === tagFilter)) return false;
        if (assigneeFilter === "unassigned" && t.assignees.length) return false;
        if (
          assigneeFilter !== "all" &&
          assigneeFilter !== "unassigned" &&
          !t.assignees.some((a) => a.user.id === assigneeFilter)
        )
          return false;
        return true;
      }),
    [tasks, priorityFilter, assigneeFilter, tagFilter],
  );

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
        <span className="text-sm text-muted-foreground">{ctx?.space.name ?? "Space"}</span>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-semibold text-slate-800">{ctx?.listName ?? "List"}</span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-4 py-1.5">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition",
              view === v.key
                ? "bg-muted text-slate-800"
                : "text-slate-500 hover:bg-muted/60 hover:text-slate-700",
            )}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
              <path d={v.icon} stroke="currentColor" strokeWidth="2" />
            </svg>
            {v.label}
          </button>
        ))}
        <ViewsAndCycles
          listId={listId}
          spaceId={spaceId}
          layout={view}
          filters={{ priority: priorityFilter, assignee: assigneeFilter, tag: tagFilter, groupBy, sort, sortDir }}
          onApply={(v) => {
            setView(v.layout);
            const f = v.filters as ViewSettings;
            setPriorityFilter(f.priority ?? "all");
            setAssigneeFilter(f.assignee ?? "all");
            setTagFilter(f.tag ?? "all");
            setGroupBy(f.groupBy ?? "status");
            setSort(f.sort ?? "manual");
            setSortDir(f.sortDir ?? "asc");
          }}
        />

        <div className="ml-auto flex items-center gap-2">
          <SaveTemplateButton listId={listId} listName={ctx?.listName ?? "List"} disabled={!tasks.length} />
          {view === "list" && (
            <FilterSelect label="Group" value={groupBy} onChange={(v) => setGroupBy(v as GroupBy)} options={GROUP_OPTIONS} neutral="status" />
          )}
          {(view === "list" || view === "table") && (
            <>
              <FilterSelect label="Sort" value={sort} onChange={(v) => setSort(v as SortKey)} options={SORT_OPTIONS} neutral="manual" />
              {sort !== "manual" && (
                <button
                  type="button"
                  onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                  title={sortDir === "asc" ? "Ascending" : "Descending"}
                  className="rounded-md border border-border px-2 py-1 text-sm text-slate-500 hover:bg-muted"
                >
                  {sortDir === "asc" ? "↑" : "↓"}
                </button>
              )}
            </>
          )}
          <FilterSelect
            label="Priority"
            value={priorityFilter}
            onChange={setPriorityFilter}
            options={[
              { value: "all", label: "All priorities" },
              ...(Object.keys(PRIORITY) as Priority[]).map((p) => ({
                value: p,
                label: PRIORITY[p].label,
              })),
            ]}
          />
          <FilterSelect
            label="Assignee"
            value={assigneeFilter}
            onChange={setAssigneeFilter}
            options={[
              { value: "all", label: "Anyone" },
              { value: "unassigned", label: "Unassigned" },
              ...members.map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
          <FilterSelect
            label="Tag"
            value={tagFilter}
            onChange={setTagFilter}
            options={[{ value: "all", label: "Any tag" }, ...tags.map((t) => ({ value: t.id, label: t.name }))]}
          />
        </div>
      </div>

      {/* Quick add */}
      <div className="flex items-center gap-2 border-b border-border px-5 py-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && createTask.mutate(draft.trim())}
          placeholder="+ Add task…"
          className="w-72 rounded-md border border-border bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
        <Button variant="primary" onClick={() => draft.trim() && createTask.mutate(draft.trim())}>
          Add Task
        </Button>
        {(assigneeFilter !== "all" || priorityFilter !== "all" || tagFilter !== "all") && (
          <span className="text-xs text-muted-foreground">
            {filtered.length} of {tasks.length} shown
          </span>
        )}
      </div>

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          statuses={statuses}
          members={members}
          tags={tags}
          spaces={spaces}
          currentListId={listId}
          pending={bulk.isPending}
          onApply={(patch) => bulk.mutate(patch)}
          onClear={() => setSelected(new Set())}
          onSelectAll={() => setSelected(new Set(filtered.map((t) => t.id)))}
          total={filtered.length}
        />
      )}

      {/* Active view */}
      <div className="flex-1 overflow-auto bg-[#fafafa]">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading tasks…</p>
        ) : view === "board" ? (
          <BoardView
            tasks={filtered}
            statuses={statuses}
            onOpenTask={setOpenTaskId}
            onMoveTask={(taskId, statusId) => onUpdate(taskId, { statusId })}
          />
        ) : view === "list" ? (
          <ListView
            tasks={filtered}
            statuses={statuses}
            members={members}
            groupBy={groupBy}
            sort={sort}
            sortDir={sortDir}
            onOpenTask={setOpenTaskId}
            onUpdate={onUpdate}
            selected={selected}
            onToggleSelect={toggleSelect}
          />
        ) : view === "calendar" ? (
          <CalendarView tasks={filtered} onOpenTask={setOpenTaskId} onReschedule={(taskId, dueDate) => onUpdate(taskId, { dueDate })} />
        ) : (
          <TableView
            tasks={filtered}
            statuses={statuses}
            members={members}
            sort={sort}
            sortDir={sortDir}
            onSort={(key) => {
              if (key === sort) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
              else {
                setSort(key);
                setSortDir("asc");
              }
            }}
            onOpenTask={setOpenTaskId}
            onUpdate={onUpdate}
            selected={selected}
            onToggleSelect={toggleSelect}
            onToggleAll={(checked) => setSelected(checked ? new Set(filtered.map((t) => t.id)) : new Set())}
          />
        )}
      </div>

      {openTaskId && (
        <TaskDetail spaceId={spaceId}
          taskId={openTaskId}
          listId={listId}
          statuses={statuses}
          members={members}
          onClose={() => setOpenTaskId(null)}
        />
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  neutral = "all",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** The value that counts as "no filter applied". */
  neutral?: string;
}) {
  const active = value !== neutral;
  return (
    <label
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm",
        active ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border text-slate-500",
      )}
    >
      <span className="text-xs font-medium">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-sm outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Snapshot this list (tasks, subtasks, project milestones) as a reusable template. */
function SaveTemplateButton({ listId, listName, disabled }: { listId: string; listName: string; disabled: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.createTemplateFromList({ listId, name: name.trim() }),
    onSuccess: (t) => {
      setResult(`Saved “${t.name}” — apply it from any project page.`);
      setName("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["task-templates"] });
      window.setTimeout(() => setResult(null), 4000);
    },
  });
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setName(`${listName} template`);
          setOpen((o) => !o);
        }}
        title="Save this list's tasks, subtasks and milestones as a template"
        className="rounded-md border border-border px-2 py-1 text-xs text-slate-600 hover:bg-muted disabled:opacity-40"
      >
        Save as template
      </button>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-border bg-white p-2 shadow-lg"
        >
          <p className="mb-1 text-[11px] text-muted-foreground">Due dates are stored as offsets from the project start.</p>
          <div className="flex gap-1">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-xs outline-none focus:border-indigo-500" />
            <button type="submit" disabled={!name.trim() || save.isPending} className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">
              Save
            </button>
          </div>
        </form>
      )}
      {result && <span className="absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-[11px] text-white">{result}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Bulk actions bar (row 35): change status, assignee, due date, tags or
 * list/project for every selected task in one go.
 * ------------------------------------------------------------------ */
function BulkBar({
  count,
  total,
  statuses,
  members,
  tags,
  spaces,
  currentListId,
  pending,
  onApply,
  onClear,
  onSelectAll,
}: {
  count: number;
  total: number;
  statuses: Status[];
  members: Member[];
  tags: Tag[];
  spaces: SpaceTree[];
  currentListId: string;
  pending: boolean;
  onApply: (patch: BulkTaskPatch) => void;
  onClear: () => void;
  onSelectAll: () => void;
}) {
  const sel = "rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs text-slate-700";
  const lists = spaces.flatMap((sp) => [
    ...sp.lists.map((l) => ({ id: l.id, label: `${sp.name} › ${l.name}` })),
    ...sp.folders.flatMap((f) => f.lists.map((l) => ({ id: l.id, label: `${sp.name} › ${f.name} › ${l.name}` }))),
  ]);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-indigo-200 bg-indigo-50 px-5 py-2 text-xs">
      <span className="font-semibold text-indigo-800">
        {count} selected
        {count < total && (
          <button type="button" onClick={onSelectAll} className="ml-2 font-normal text-indigo-600 underline-offset-2 hover:underline">
            select all {total}
          </button>
        )}
      </span>
      <select value="" disabled={pending} onChange={(e) => e.target.value && onApply({ statusId: e.target.value })} className={sel}>
        <option value="">Status…</option>
        {statuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <select value="" disabled={pending} onChange={(e) => e.target.value && onApply({ priority: e.target.value === "none" ? null : (e.target.value as Priority) })} className={sel}>
        <option value="">Priority…</option>
        {(Object.keys(PRIORITY) as Priority[]).map((p) => (
          <option key={p} value={p}>
            {PRIORITY[p].label}
          </option>
        ))}
        <option value="none">No priority</option>
      </select>
      <select
        value=""
        disabled={pending}
        onChange={(e) => e.target.value && onApply({ assigneeIds: e.target.value === "none" ? [] : [e.target.value] })}
        className={sel}
      >
        <option value="">Assign to…</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
        <option value="none">Unassign</option>
      </select>
      <label className="flex items-center gap-1 text-slate-600">
        Due
        <input type="date" disabled={pending} onChange={(e) => e.target.value && onApply({ dueDate: `${e.target.value}T00:00:00.000Z` })} className={sel} />
        <button type="button" disabled={pending} onClick={() => onApply({ dueDate: null })} className="text-slate-500 hover:text-red-500" title="Clear due date">
          ✕
        </button>
      </label>
      <select value="" disabled={pending} onChange={(e) => e.target.value && onApply({ addTagIds: [e.target.value] })} className={sel}>
        <option value="">Add tag…</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select value="" disabled={pending} onChange={(e) => e.target.value && onApply({ listId: e.target.value })} className={sel}>
        <option value="">Move to list…</option>
        {lists
          .filter((l) => l.id !== currentListId)
          .map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
      </select>
      <button type="button" onClick={onClear} className="ml-auto text-slate-500 hover:text-slate-800">
        Clear selection
      </button>
      {pending && <span className="text-indigo-700">Applying…</span>}
    </div>
  );
}
