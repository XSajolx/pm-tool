import { useMemo, useState } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Priority, type Task } from "../lib/api.js";
import { Button, PRIORITY } from "../components/ui.js";
import { TaskDetail } from "../components/TaskDetail.js";
import { ViewsAndCycles } from "../components/ViewsAndCycles.js";
import { BoardView } from "./BoardView.js";
import { ListView } from "./ListView.js";
import { TableView } from "./TableView.js";
import { cn } from "../lib/utils.js";

type ViewKey = "list" | "board" | "table";
const VIEWS: { key: ViewKey; label: string; icon: string }[] = [
  { key: "list", label: "List", icon: "M4 6h16M4 12h16M4 18h10" },
  { key: "board", label: "Board", icon: "M4 4h6v16H4zM14 4h6v10h-6z" },
  { key: "table", label: "Table", icon: "M3 5h18v14H3zM3 10h18M9 5v14" },
];

export function WorkspacePage() {
  const { listId } = useParams({ from: "/l/$listId" });
  const qc = useQueryClient();
  const [view, setView] = useState<ViewKey>("list");
  // Deep links (/t/:id) land here with ?task=<id> so the panel opens on arrival.
  const search = useSearch({ strict: false }) as { task?: string };
  const [openTaskId, setOpenTaskId] = useState<string | null>(search.task ?? null);
  const [draft, setDraft] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");

  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });

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

  // Optimistic drag-to-move between board columns.
  const moveTask = useMutation({
    mutationFn: ({ taskId, statusId }: { taskId: string; statusId: string }) =>
      api.updateTask(taskId, { statusId }),
    onMutate: async ({ taskId, statusId }) => {
      await qc.cancelQueries({ queryKey: ["tasks", listId] });
      const prev = qc.getQueryData<Task[]>(["tasks", listId]);
      qc.setQueryData<Task[]>(["tasks", listId], (old = []) =>
        old.map((t) =>
          t.id === taskId
            ? { ...t, statusId, status: statuses.find((s) => s.id === statusId) ?? t.status }
            : t,
        ),
      );
      return { prev };
    },
    onError: (_e, _v, c) => c?.prev && qc.setQueryData(["tasks", listId], c.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks", listId] }),
  });

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
        if (assigneeFilter === "unassigned" && t.assignees.length) return false;
        if (
          assigneeFilter !== "all" &&
          assigneeFilter !== "unassigned" &&
          !t.assignees.some((a) => a.user.id === assigneeFilter)
        )
          return false;
        return true;
      }),
    [tasks, priorityFilter, assigneeFilter],
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
          filters={{ priority: priorityFilter, assignee: assigneeFilter }}
          onApply={(v) => {
            setView(v.layout);
            const f = v.filters as { priority?: string; assignee?: string };
            setPriorityFilter(f.priority ?? "all");
            setAssigneeFilter(f.assignee ?? "all");
          }}
        />

        <div className="ml-auto flex items-center gap-2">
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
        {(assigneeFilter !== "all" || priorityFilter !== "all") && (
          <span className="text-xs text-muted-foreground">
            {filtered.length} of {tasks.length} shown
          </span>
        )}
      </div>

      {/* Active view */}
      <div className="flex-1 overflow-auto bg-[#fafafa]">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading tasks…</p>
        ) : view === "board" ? (
          <BoardView
            tasks={filtered}
            statuses={statuses}
            onOpenTask={setOpenTaskId}
            onMoveTask={(taskId, statusId) => moveTask.mutate({ taskId, statusId })}
          />
        ) : view === "list" ? (
          <ListView tasks={filtered} statuses={statuses} onOpenTask={setOpenTaskId} />
        ) : (
          <TableView tasks={filtered} statuses={statuses} onOpenTask={setOpenTaskId} />
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const active = value !== "all";
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
