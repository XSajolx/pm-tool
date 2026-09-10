import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SavedView } from "../lib/api.js";
import { cn } from "../lib/utils.js";

export interface ToolbarFilters {
  priority: string;
  assignee: string;
}

interface Props {
  listId: string;
  spaceId?: string;
  layout: string;
  filters: ToolbarFilters;
  onApply: (view: SavedView) => void;
}

/**
 * Saved views + the current cycle, sitting in the list toolbar.
 *
 * A "view" is just the toolbar's own state (layout + filters) persisted under a
 * name, which is why saving one needs no extra UI beyond a name prompt: whatever
 * is on screen right now *is* the view.
 */
export function ViewsAndCycles({ listId, spaceId, layout, filters, onApply }: Props) {
  return (
    <>
      <SavedViews
        listId={listId}
        layout={layout}
        filters={filters}
        onApply={onApply}
      />
      {spaceId && <CycleChip spaceId={spaceId} />}
    </>
  );
}

function SavedViews({
  listId,
  layout,
  filters,
  onApply,
}: Omit<Props, "spaceId">) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const { data: views = [] } = useQuery({
    queryKey: ["views", listId],
    queryFn: () => api.getViews(listId),
  });

  const save = useMutation({
    mutationFn: () =>
      api.createView({
        name: name.trim(),
        listId,
        layout,
        filters: filters as unknown as Record<string, unknown>,
      }),
    onSuccess: () => {
      setName("");
      setNaming(false);
      qc.invalidateQueries({ queryKey: ["views", listId] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteView(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views", listId] }),
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition",
          open ? "bg-muted text-slate-800" : "text-slate-500 hover:bg-muted/60",
        )}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 6h16M7 12h10M10 18h4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        Views
        {views.length ? (
          <span className="text-xs text-muted-foreground">({views.length})</span>
        ) : null}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-60 rounded-md border border-border bg-white p-1.5 shadow-lg">
          {views.length ? (
            views.map((v) => (
              <div key={v.id} className="group flex items-center gap-1">
                <button
                  onClick={() => {
                    onApply(v);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-muted"
                >
                  {v.name}
                  <span className="ml-1.5 text-xs capitalize text-muted-foreground">
                    {v.layout}
                  </span>
                </button>
                <button
                  onClick={() => remove.mutate(v.id)}
                  title="Delete view"
                  className="shrink-0 px-1 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-500"
                >
                  ✕
                </button>
              </div>
            ))
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No saved views yet.
            </p>
          )}

          <div className="mt-1 border-t border-border pt-1">
            {naming ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) save.mutate();
                }}
                className="flex gap-1 p-1"
              >
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="View name"
                  className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-xs outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  className="shrink-0 rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  Save
                </button>
              </form>
            ) : (
              <button
                onClick={() => setNaming(true)}
                className="w-full rounded px-2 py-1.5 text-left text-sm font-medium text-indigo-600 hover:bg-muted"
              >
                + Save current view
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shows the space's active cycle and how far through it is. */
function CycleChip({ spaceId }: { spaceId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const { data: cycles = [] } = useQuery({
    queryKey: ["cycles", spaceId],
    queryFn: () => api.getCycles(spaceId),
  });

  const create = useMutation({
    mutationFn: () => api.createCycle({ spaceId, name: name.trim() }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["cycles", spaceId] });
    },
  });

  const active = cycles.find((c) => c.state === "active") ?? cycles[0];
  const pct = active?.progress.total
    ? Math.round((active.progress.done / active.progress.total) * 100)
    : 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition",
          open ? "bg-muted text-slate-800" : "text-slate-500 hover:bg-muted/60",
        )}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {active ? (
          <>
            <span className="max-w-[110px] truncate">{active.name}</span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-200">
                <span
                  className="block h-full rounded-full bg-indigo-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {active.progress.done}/{active.progress.total}
              </span>
            </span>
          </>
        ) : (
          "Cycles"
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-border bg-white p-1.5 shadow-lg">
          {cycles.length ? (
            cycles.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-slate-700">{c.name}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase",
                    c.state === "active"
                      ? "bg-green-50 text-green-700"
                      : c.state === "upcoming"
                        ? "bg-slate-100 text-slate-600"
                        : "bg-violet-50 text-violet-700",
                  )}
                >
                  {c.state}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {c.progress.done}/{c.progress.total}
                </span>
              </div>
            ))
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No cycles yet.</p>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
            className="mt-1 flex gap-1 border-t border-border p-1 pt-2"
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New cycle name"
              className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-xs outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="shrink-0 rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700"
            >
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
