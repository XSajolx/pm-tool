import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ClickUpListMapping, type ClickUpPreview, type ClickUpResult } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Row 126: ClickUp CSV → this workspace, in three steps: upload, map lists and
 * statuses (with a preview of what will land where), import. Nothing is
 * written until "Import" is pressed; a second run of the same file skips
 * tasks that already came in.
 */
type Dest = { mode: "existing"; listId: string } | { mode: "new"; spaceId: string; listName: string } | { mode: "newSpace"; spaceName: string; listName: string } | { mode: "skip" };

export function ClickUpImportSettings() {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<ClickUpPreview | null>(null);
  const [dest, setDest] = useState<Record<string, Dest>>({});
  const [statusMap, setStatusMap] = useState<Record<string, Record<string, string>>>({});
  const [assignees, setAssignees] = useState<Record<string, string | null>>({});
  const [result, setResult] = useState<ClickUpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const up = useMutation({
    mutationFn: (f: File) => api.previewClickUp(f),
    onSuccess: (p) => {
      setPreview(p);
      setResult(null);
      setError(null);
      const d: Record<string, Dest> = {};
      for (const l of p.lists) d[l.key] = l.suggestedListId ? { mode: "existing", listId: l.suggestedListId } : l.suggestedSpaceId ? { mode: "new", spaceId: l.suggestedSpaceId, listName: l.list } : { mode: "newSpace", spaceName: l.space || "Imported from ClickUp", listName: l.list };
      setDest(d);
      setStatusMap({});
      setAssignees(Object.fromEntries(p.assignees.map((a) => [a.label, a.userId])));
    },
    onError: (e: Error) => setError(e.message),
  });
  const run = useMutation({
    mutationFn: () => {
      const mapping: Record<string, ClickUpListMapping> = {};
      for (const [key, d] of Object.entries(dest)) {
        if (d.mode === "skip") continue;
        const m: ClickUpListMapping = d.mode === "existing" ? { listId: d.listId } : d.mode === "new" ? { createIn: { spaceId: d.spaceId, listName: d.listName } } : { createIn: { newSpaceName: d.spaceName, listName: d.listName } };
        if (statusMap[key]) m.statuses = statusMap[key];
        mapping[key] = m;
      }
      return api.runClickUpImport({ importId: preview!.importId, mapping, assignees });
    },
    onSuccess: (r) => { setResult(r); setPreview(null); qc.invalidateQueries({ queryKey: ["spaces"] }); qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: ["statuses"] }); qc.invalidateQueries({ queryKey: ["tags"] }); },
    onError: (e: Error) => setError(e.message),
  });
  const field = "rounded-md border border-border bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500";
  const spaceOfDest = (d: Dest) => d.mode === "existing" ? preview?.existingLists.find((l) => l.id === d.listId)?.spaceId ?? null : d.mode === "new" ? d.spaceId : null;
  const planned = preview ? preview.lists.filter((l) => dest[l.key]?.mode !== "skip").reduce((a, l) => a + l.count - l.already, 0) : 0;

  return (
    <div className="max-w-3xl" data-testid="clickup-import">
      <h1 className="text-lg font-semibold text-slate-900">Import from ClickUp</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        In ClickUp: List › ⋯ › Export › CSV (or a Space/Workspace export). Upload it here, choose where each ClickUp list lands and how its statuses map, check the preview, then import. Tasks keep their title, description, status, priority, dates, estimate, assignees, tags and subtasks.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="cursor-pointer rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
          {up.isPending ? "Reading…" : "Choose CSV export"}
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && up.mutate(e.target.files[0])} data-testid="clickup-file" />
        </label>
        {preview && <span className="text-xs text-muted-foreground">{preview.filename} · {preview.totalRows} rows · {preview.subtasks} subtasks{preview.alreadyImported ? ` · ${preview.alreadyImported} already imported (will be skipped)` : ""}</span>}
      </div>
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      {preview && (
        <div className="mt-5 space-y-5">
          <section className="rounded-lg border border-border bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-800">Where each list goes</h2>
            <ul className="mt-3 space-y-4">
              {preview.lists.map((l) => {
                const d = dest[l.key] ?? { mode: "skip" as const };
                const targetSpace = spaceOfDest(d);
                return (
                  <li key={l.key} className="rounded-md border border-border p-3" data-testid="clickup-list-row">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-800">{l.list} <span className="text-xs font-normal text-muted-foreground">{[l.space, l.folder].filter((x) => x && x !== "—").join(" › ")}</span></p>
                        <p className="text-xs text-muted-foreground">{l.count} task{l.count === 1 ? "" : "s"}{l.already ? ` (${l.already} already here)` : ""} · e.g. {l.sample.join(", ")}</p>
                      </div>
                      <select value={d.mode} onChange={(e) => { const mode = e.target.value as Dest["mode"]; setDest((x) => ({ ...x, [l.key]: mode === "existing" ? { mode, listId: l.suggestedListId ?? preview.existingLists[0]?.id ?? "" } : mode === "new" ? { mode, spaceId: l.suggestedSpaceId ?? preview.spaces[0]?.id ?? "", listName: l.list } : mode === "newSpace" ? { mode, spaceName: l.space || "Imported from ClickUp", listName: l.list } : { mode } })); }} className={field}>
                        <option value="existing">Into an existing list</option>
                        <option value="new">New list in a space</option>
                        <option value="newSpace">New space + list</option>
                        <option value="skip">Skip this list</option>
                      </select>
                      {d.mode === "existing" && (
                        <select value={d.listId} onChange={(e) => setDest((x) => ({ ...x, [l.key]: { mode: "existing", listId: e.target.value } }))} className={field}>
                          {preview.existingLists.map((el) => <option key={el.id} value={el.id}>{preview.spaces.find((s) => s.id === el.spaceId)?.name ?? "?"} › {el.name}</option>)}
                        </select>
                      )}
                      {d.mode === "new" && (
                        <>
                          <select value={d.spaceId} onChange={(e) => setDest((x) => ({ ...x, [l.key]: { ...d, spaceId: e.target.value } }))} className={field}>
                            {preview.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                          <input value={d.listName} onChange={(e) => setDest((x) => ({ ...x, [l.key]: { ...d, listName: e.target.value } }))} className={`${field} w-40`} placeholder="List name" />
                        </>
                      )}
                      {d.mode === "newSpace" && (
                        <>
                          <input value={d.spaceName} onChange={(e) => setDest((x) => ({ ...x, [l.key]: { ...d, spaceName: e.target.value } }))} className={`${field} w-40`} placeholder="Space name" />
                          <input value={d.listName} onChange={(e) => setDest((x) => ({ ...x, [l.key]: { ...d, listName: e.target.value } }))} className={`${field} w-40`} placeholder="List name" />
                        </>
                      )}
                    </div>
                    {d.mode !== "skip" && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {l.statuses.map((st) => (
                          <StatusPick key={st.name} label={`${st.name} (${st.count})`} spaceId={targetSpace} value={statusMap[l.key]?.[st.name] ?? "create"} onChange={(v) => setStatusMap((m) => ({ ...m, [l.key]: { ...(m[l.key] ?? {}), [st.name]: v } }))} />
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {preview.assignees.length > 0 && (
            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-800">People</h2>
              <p className="text-xs text-muted-foreground">ClickUp assignee → workspace member. Leave blank to import unassigned.</p>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {preview.assignees.map((a) => (
                  <li key={a.label} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-slate-700">{a.label} <span className="text-xs text-muted-foreground">({a.count})</span></span>
                    <select value={assignees[a.label] ?? ""} onChange={(e) => setAssignees((m) => ({ ...m, [a.label]: e.target.value || null }))} className={field}>
                      <option value="">— unassigned —</option>
                      {preview.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-wrap items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
            <p className="text-sm text-indigo-900">
              Ready to import <strong>{planned}</strong> task{planned === 1 ? "" : "s"}{preview.tags.length ? ` with ${preview.tags.length} tag${preview.tags.length === 1 ? "" : "s"}` : ""}. Statuses set to "create" are added to the target space with a matching name.
            </p>
            <button type="button" disabled={run.isPending || planned === 0} onClick={() => run.mutate()} className="ml-auto rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50" data-testid="clickup-run">
              {run.isPending ? "Importing…" : `Import ${planned} tasks`}
            </button>
          </section>
        </div>
      )}

      {result && (
        <div className="mt-5 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900" data-testid="clickup-result">
          <p className="font-medium">Import finished.</p>
          <p className="mt-1">{result.created} created · {result.subtasks} as subtasks · {result.assigned} assignments · {result.tagged} tags · {result.skipped} skipped</p>
          {result.unmappedLists.length > 0 && <p className="mt-1 text-xs">Skipped lists: {result.unmappedLists.join(", ")}</p>}
          {result.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-red-700">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

/** Status mapping for one ClickUp status against the statuses of the chosen target space. */
function StatusPick({ label, spaceId, value, onChange }: { label: string; spaceId: string | null; value: string; onChange: (v: string) => void }) {
  const { data: statuses = [] } = useQuery({ queryKey: ["statuses", spaceId], queryFn: () => api.getStatuses(spaceId!), enabled: Boolean(spaceId) });
  return (
    <label className="inline-flex items-center gap-1 rounded-md border border-border bg-[#fbfbfa] px-2 py-1 text-xs text-slate-700">
      <span className="max-w-[10rem] truncate">{label}</span>
      <span className="text-muted-foreground">→</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cn("rounded border border-border bg-white px-1 py-0.5 text-xs", value === "create" && "text-indigo-700")}>
        <option value="create">{spaceId ? "create with same name" : "create in the new space"}</option>
        {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}
