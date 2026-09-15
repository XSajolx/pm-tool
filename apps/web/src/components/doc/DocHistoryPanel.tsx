import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DocVersion } from "../../lib/api.js";
import { DocReadOnly } from "./DocReadOnly.js";
import { relativeTime } from "../TaskCollaboration.js";
import { cn } from "../../lib/utils.js";

/** Row 21: browse earlier versions, preview one, restore it or save a named one. */
export function DocHistoryPanel({ docId, onClose, onRestored }: { docId: string; onClose: () => void; onRestored: () => void }) {
  const qc = useQueryClient();
  const { data: versions = [], isLoading } = useQuery({ queryKey: ["doc-versions", docId], queryFn: () => api.getDocVersions(docId) });
  const [selected, setSelected] = useState<string | null>(null);
  const { data: preview } = useQuery({ queryKey: ["doc-version", docId, selected], queryFn: () => api.getDocVersion(docId, selected!), enabled: Boolean(selected) });
  const [label, setLabel] = useState("");
  const save = useMutation({ mutationFn: () => api.saveDocVersion(docId, label.trim() || null), onSuccess: () => { setLabel(""); qc.invalidateQueries({ queryKey: ["doc-versions", docId] }); } });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreDocVersion(docId, id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["doc-versions", docId] }); qc.invalidateQueries({ queryKey: ["document", docId] }); setSelected(null); onRestored(); },
  });
  const reasonLabel = (v: DocVersion) => (v.reason === "manual" ? v.label || "Saved version" : v.reason === "restore" ? "Before a restore" : "Autosaved");

  return (
    <aside className="flex h-full w-[28rem] shrink-0 flex-col border-l border-border bg-[#fbfbfa]" data-testid="doc-history">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h2>
        <span className="text-[11px] text-muted-foreground">{versions.length} version{versions.length === 1 ? "" : "s"}</span>
        <button type="button" onClick={onClose} className="ml-auto text-xs text-muted-foreground hover:text-slate-700">✕</button>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="flex items-center gap-2 border-b border-border px-3 py-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name this version (optional)" className="min-w-0 flex-1 rounded-md border border-border bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400" />
        <button type="submit" disabled={save.isPending} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50" data-testid="doc-save-version">Save version</button>
      </form>
      <div className="flex min-h-0 flex-1">
        <ul className="w-44 shrink-0 overflow-y-auto border-r border-border">
          {isLoading && <li className="p-3 text-xs text-muted-foreground">Loading…</li>}
          {!isLoading && versions.length === 0 && <li className="p-3 text-xs text-muted-foreground">No versions yet. They appear as the doc is edited, or when you save one.</li>}
          {versions.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => setSelected(v.id)} className={cn("block w-full px-3 py-2 text-left hover:bg-muted", selected === v.id && "bg-indigo-50")} data-testid="doc-version-row">
                <p className="truncate text-xs font-medium text-slate-800">{reasonLabel(v)}</p>
                <p className="text-[11px] text-muted-foreground">{relativeTime(v.createdAt)}{v.createdBy ? ` · ${v.createdBy.name}` : ""}</p>
                <p className="text-[10px] text-muted-foreground">{v.words} words</p>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1 overflow-y-auto p-3">
          {!selected ? (
            <p className="text-xs text-muted-foreground">Pick a version to preview it here.</p>
          ) : !preview ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{preview.title}</p>
                <button type="button" disabled={restore.isPending} onClick={() => restore.mutate(preview.id)} className="rounded-md border border-border bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50" title="Make this the current version (the current one is kept as a version first)" data-testid="doc-restore-version">
                  Restore this version
                </button>
              </div>
              <div className="rounded-md border border-border bg-white p-3 text-sm">
                <DocReadOnly content={preview.content ?? null} body={preview.body ?? ""} />
              </div>
            </>
          )}
          {restore.isError && <p className="mt-2 text-xs text-red-600">{(restore.error as Error).message}</p>}
        </div>
      </div>
    </aside>
  );
}
