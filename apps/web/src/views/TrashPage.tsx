import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TrashItem, type TrashType } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { cn } from "../lib/utils.js";

/** Row 125: everything deleted in the last 30 days, restorable with one click. */
const TABS: { id: TrashType | "all"; label: string }[] = [
  { id: "all", label: "All" }, { id: "task", label: "Tasks" }, { id: "document", label: "Docs" }, { id: "project", label: "Projects" },
];
const ICON: Record<TrashType, string> = { task: "☐", document: "📄", project: "▣" };

export function TrashPage() {
  const qc = useQueryClient();
  const { role } = useAuth();
  const canPurge = role === "owner" || role === "admin";
  const [tab, setTab] = useState<TrashType | "all">("all");
  const { data: items = [], isLoading } = useQuery({ queryKey: ["trash"], queryFn: api.getTrash });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["trash"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["documents"] });
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["spaces"] });
  };
  const restore = useMutation({ mutationFn: (i: TrashItem) => api.restoreFromTrash(i.type, i.id), onSuccess: refresh });
  const purge = useMutation({ mutationFn: (i: TrashItem) => api.purgeFromTrash(i.type, i.id), onSuccess: refresh });
  const [confirm, setConfirm] = useState<string | null>(null);
  const rows = items.filter((i) => tab === "all" || i.type === tab);

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden" data-testid="trash-page">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Trash</h1>
        <span className="text-xs text-muted-foreground">Deleted tasks, docs and projects stay here for 30 days. Restore brings everything back exactly as it was.</span>
      </div>
      <div className="flex gap-1 border-b border-border px-6 py-2">
        {TABS.map((t) => {
          const n = t.id === "all" ? items.length : items.filter((i) => i.type === t.id).length;
          return (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={cn("rounded-full border px-3 py-1 text-xs font-medium", tab === t.id ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:border-slate-300")}>
              {t.label}{n ? <span className="ml-1 text-muted-foreground">{n}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">🗑️</span>
            <p className="text-sm text-muted-foreground">The trash is empty.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-white">
            {rows.map((i) => (
              <li key={`${i.type}:${i.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="w-5 text-center text-slate-500">{ICON[i.type]}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-slate-800">{i.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {i.type === "task" ? "Task" : i.type === "document" ? "Doc" : "Project"}{i.context ? ` · ${i.context}` : ""} · deleted {new Date(i.deletedAt).toLocaleString()}{i.deletedBy ? ` by ${i.deletedBy}` : ""}
                  </p>
                </div>
                <span className={cn("text-xs tabular-nums", i.daysLeft <= 3 ? "text-red-600" : "text-muted-foreground")}>{i.daysLeft} day{i.daysLeft === 1 ? "" : "s"} left</span>
                <button type="button" disabled={restore.isPending} onClick={() => restore.mutate(i)} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Restore</button>
                {canPurge && (confirm === i.id ? (
                  <span className="flex items-center gap-1 text-xs">
                    <button type="button" disabled={purge.isPending} onClick={() => { purge.mutate(i); setConfirm(null); }} className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700">Delete forever</button>
                    <button type="button" onClick={() => setConfirm(null)} className="text-muted-foreground hover:text-slate-700">Cancel</button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirm(i.id)} className="text-xs text-slate-400 hover:text-red-600">Delete forever</button>
                ))}
              </li>
            ))}
          </ul>
        )}
        {(restore.isError || purge.isError) && <p className="mt-2 text-xs text-red-600">{((restore.error ?? purge.error) as Error).message}</p>}
        <p className="mt-4 text-xs text-muted-foreground">Restored projects reappear in <Link to="/projects" className="text-indigo-700 hover:underline">Projects</Link>; restored tasks and docs go back to their list and page.</p>
      </div>
    </div>
  );
}
