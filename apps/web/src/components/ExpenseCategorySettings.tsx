import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type ExpenseCategory } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Row 134: the expense categories and what each one is marked up by when it
 * is re-billed to a client. The default lands on every new expense; a project
 * manager can override one expense with a note.
 */
export function ExpenseCategorySettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["expense-category-settings"], queryFn: api.getExpenseCategorySettings });
  const [rows, setRows] = useState<{ name: string; markupPct: string; active: boolean }[]>([]);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) setRows(data.map((c) => ({ name: c.name, markupPct: String(c.markupPct), active: c.active })));
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.saveExpenseCategorySettings(rows.map((r) => ({ name: r.name, markupPct: Number(r.markupPct) || 0, active: r.active })) as ExpenseCategory[]),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["expense-category-settings"] });
      void qc.invalidateQueries({ queryKey: ["expense-categories"] });
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const dirty = data ? JSON.stringify(rows) !== JSON.stringify(data.map((c) => ({ name: c.name, markupPct: String(c.markupPct), active: c.active }))) : false;
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="max-w-2xl" data-testid="expense-categories">
      <h1 className="text-lg font-semibold text-slate-900">Expense categories & markup</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Each category carries the markup applied when an expense is re-billed on an invoice — so billable amounts are right by default. A project manager can still override a single expense, with a note.
      </p>
      {isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Category</th>
                <th className="px-3 py-2 text-right font-medium">Default markup</th>
                <th className="px-3 py-2 text-center font-medium">In use</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={cn("border-t border-border", !r.active && "opacity-50")}>
                  <td className="px-3 py-1.5">
                    <input value={r.name} disabled={!canEdit} onChange={(e) => set(i, { name: e.target.value })} className="w-full rounded border border-transparent px-1.5 py-1 text-slate-800 hover:border-border focus:border-indigo-500 focus:outline-none disabled:bg-transparent" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <span className="inline-flex items-center gap-1">
                      <input type="number" min="0" max="500" step="0.5" value={r.markupPct} disabled={!canEdit} onChange={(e) => set(i, { markupPct: e.target.value })} className={cn("w-20 rounded border px-1.5 py-1 text-right tabular-nums", Number(r.markupPct) > 0 ? "border-indigo-200 bg-indigo-50/40 text-indigo-800" : "border-border")} />
                      <span className="text-xs text-muted-foreground">%</span>
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-center"><input type="checkbox" checked={r.active} disabled={!canEdit} onChange={(e) => set(i, { active: e.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {canEdit && (
            <div className="flex items-center gap-2 border-t border-border bg-[#fbfbfa] px-3 py-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New category…" className="w-56 rounded border border-border px-2 py-1 text-xs" onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { setRows((r) => [...r, { name: newName.trim(), markupPct: "0", active: true }]); setNewName(""); } }} />
              <button type="button" disabled={!newName.trim()} onClick={() => { setRows((r) => [...r, { name: newName.trim(), markupPct: "0", active: true }]); setNewName(""); }} className="rounded border border-border px-2 py-1 text-xs text-slate-700 hover:bg-muted disabled:opacity-50">Add</button>
              <span className="ml-auto text-[11px] text-muted-foreground">Unticked categories stay on old expenses but leave the pickers.</span>
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {canEdit && dirty && (
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="mt-3 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save categories"}
        </button>
      )}
    </div>
  );
}
