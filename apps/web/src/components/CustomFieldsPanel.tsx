import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CustomFieldEntity, type CustomFieldWithValue } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Row 114: the custom fields of one record. Each input saves on change/blur;
 * the panel hides itself when the workspace has no fields for this entity.
 */
export function CustomFieldsPanel({ entityType, entityId, canEdit = true, layout = "rows", className }: { entityType: CustomFieldEntity; entityId: string; canEdit?: boolean; layout?: "rows" | "grid"; className?: string }) {
  const qc = useQueryClient();
  const key = ["custom-field-values", entityType, entityId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.getCustomFieldValues(entityType, entityId) });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers, enabled: Boolean(data?.fields.some((f) => f.type === "user")) });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.setCustomFieldValues(entityType, entityId, values),
    onSuccess: (next) => { qc.setQueryData(key, next); setError(null); },
    onError: (e: Error) => setError(e.message),
  });
  if (!data || !data.fields.length) return null;
  const set = (id: string, value: unknown) => save.mutate({ [id]: value });
  const input = "w-full rounded-md border border-border bg-white px-2 py-1 text-sm text-slate-800 outline-none focus:border-indigo-400 disabled:bg-muted/40";

  const control = (f: CustomFieldWithValue) => {
    const v = f.value;
    switch (f.type) {
      case "checkbox":
        return <input type="checkbox" checked={v === true} disabled={!canEdit} onChange={(e) => set(f.id, e.target.checked)} className="h-4 w-4 accent-indigo-600" aria-label={f.name} />;
      case "select":
        return (
          <select value={typeof v === "string" ? v : ""} disabled={!canEdit} onChange={(e) => set(f.id, e.target.value || null)} className={input} aria-label={f.name}>
            <option value="">—</option>
            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        );
      case "user":
        return (
          <select value={typeof v === "string" ? v : ""} disabled={!canEdit} onChange={(e) => set(f.id, e.target.value || null)} className={input} aria-label={f.name}>
            <option value="">—</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            {typeof v === "string" && !members.some((m) => m.id === v) && data.users[v] && <option value={v}>{data.users[v]}</option>}
          </select>
        );
      case "date":
        return <input type="date" value={typeof v === "string" ? v : ""} disabled={!canEdit} onChange={(e) => set(f.id, e.target.value || null)} className={input} aria-label={f.name} />;
      case "number":
        return <input type="number" key={String(v)} defaultValue={typeof v === "number" ? v : ""} disabled={!canEdit} onBlur={(e) => (e.target.value === "" ? v !== null && set(f.id, null) : Number(e.target.value) !== v && set(f.id, Number(e.target.value)))} className={input} aria-label={f.name} />;
      case "url":
        return (
          <div className="flex items-center gap-1">
            <input type="url" key={String(v)} defaultValue={typeof v === "string" ? v : ""} placeholder="https://…" disabled={!canEdit} onBlur={(e) => (e.target.value.trim() || null) !== (v ?? null) && set(f.id, e.target.value.trim() || null)} className={input} aria-label={f.name} />
            {typeof v === "string" && v && <a href={v} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-indigo-700 hover:underline" title={v}>open ↗</a>}
          </div>
        );
      default:
        return <input key={String(v)} defaultValue={typeof v === "string" ? v : ""} disabled={!canEdit} onBlur={(e) => (e.target.value.trim() || null) !== (v ?? null) && set(f.id, e.target.value.trim() || null)} className={input} aria-label={f.name} />;
    }
  };

  return (
    <div className={cn(layout === "grid" ? "grid grid-cols-2 gap-3 md:grid-cols-4" : "space-y-2", className)} data-testid={`custom-fields-${entityType}`}>
      {data.fields.map((f) => (
        layout === "grid" ? (
          <label key={f.id} className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{f.name}{f.required ? " *" : ""}</span>
            {control(f)}
          </label>
        ) : (
          <div key={f.id} className="grid grid-cols-[90px_1fr] items-center gap-2">
            <span className="truncate text-xs font-medium text-muted-foreground" title={f.name}>{f.name}{f.required ? " *" : ""}</span>
            {control(f)}
          </div>
        )
      ))}
      {error && <p className="col-span-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
