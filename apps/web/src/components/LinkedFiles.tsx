import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type LinkedEntity, type LinkedFile } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Row 124: files that live in Drive / Dropbox, linked here - name, provider,
 * last modified - never copied. Paste a link; if the provider is connected
 * (Settings › Connections) the real name and modified time come along.
 */
const PROVIDER: Record<LinkedFile["provider"], { label: string; icon: string }> = {
  google_drive: { label: "Google Drive", icon: "🟢" },
  dropbox: { label: "Dropbox", icon: "🔷" },
  link: { label: "Link", icon: "🔗" },
};

export function LinkedFiles({ entityType, entityId, canEdit = true, compact }: { entityType: LinkedEntity; entityId: string; canEdit?: boolean; compact?: boolean }) {
  const qc = useQueryClient();
  const key = ["linked-files", entityType, entityId];
  const { data: files = [] } = useQuery({ queryKey: key, queryFn: () => api.getLinkedFiles(entityType, entityId) });
  const set = (next: LinkedFile[]) => qc.setQueryData(key, next);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({ mutationFn: () => api.addLinkedFile({ entityType, entityId, url: url.trim(), name: name.trim() || null }), onSuccess: (n) => { set(n); setUrl(""); setName(""); setAdding(false); setError(null); }, onError: (e: Error) => setError(e.message) });
  const refresh = useMutation({ mutationFn: (id: string) => api.refreshLinkedFile(id), onSuccess: set, onError: (e: Error) => setError(e.message) });
  const remove = useMutation({ mutationFn: (id: string) => api.removeLinkedFile(id), onSuccess: set, onError: (e: Error) => setError(e.message) });
  const field = "rounded-md border border-border bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400";

  return (
    <div className={cn(compact ? "" : "rounded-lg border border-border bg-white p-3")} data-testid={`linked-files-${entityType}`}>
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Linked files</p>
        {files.length > 0 && <span className="text-[11px] text-muted-foreground">{files.length}</span>}
        {canEdit && !adding && (
          <button type="button" onClick={() => setAdding(true)} className="ml-auto text-xs text-indigo-700 hover:underline">+ Link a file</button>
        )}
      </div>
      {files.length > 0 && (
        <ul className="mt-1.5 divide-y divide-border">
          {files.map((f) => {
            const p = PROVIDER[f.provider];
            return (
              <li key={f.id} className="flex items-center gap-2 py-1.5 text-sm">
                {f.iconUrl ? <img src={f.iconUrl} alt="" className="h-4 w-4" /> : <span className="w-4 text-center text-xs" title={p.label}>{p.icon}</span>}
                <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-slate-800 hover:text-indigo-700 hover:underline" title={f.url}>{f.name}</a>
                <span className="hidden text-[11px] text-muted-foreground sm:inline">
                  {p.label}
                  {f.lastModifiedAt ? ` · modified ${new Date(f.lastModifiedAt).toLocaleDateString()}` : ""}
                  {f.addedBy ? ` · by ${f.addedBy.name}` : ""}
                </span>
                {canEdit && f.provider !== "link" && (
                  <button type="button" onClick={() => refresh.mutate(f.id)} disabled={refresh.isPending} className="text-[11px] text-slate-500 hover:text-indigo-700" title="Re-read name and modified time from the provider">↻</button>
                )}
                {canEdit && <button type="button" onClick={() => remove.mutate(f.id)} className="text-[11px] text-slate-400 hover:text-red-600" title="Unlink (the file itself is untouched)">×</button>}
              </li>
            );
          })}
        </ul>
      )}
      {files.length === 0 && !adding && <p className="mt-1 text-xs text-muted-foreground">No linked files.</p>}
      {adding && (
        <form onSubmit={(e) => { e.preventDefault(); if (url.trim()) add.mutate(); }} className="mt-2 flex flex-wrap items-center gap-1.5">
          <input autoFocus type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a Drive or Dropbox link…" className={`${field} min-w-[16rem] flex-1`} required />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={`${field} w-36`} />
          <button type="submit" disabled={!url.trim() || add.isPending} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Link</button>
          <button type="button" onClick={() => { setAdding(false); setError(null); }} className="text-xs text-muted-foreground hover:text-slate-700">Cancel</button>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
