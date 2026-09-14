import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CustomFieldDef, type CustomFieldEntity, type CustomFieldType } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/** Row 114: define the fields each record type carries. */
const ENTITIES: { id: CustomFieldEntity; label: string; hint: string }[] = [
  { id: "task", label: "Tasks", hint: "Shown in the task panel under Estimate" },
  { id: "project", label: "Projects", hint: "Shown in the project details card" },
  { id: "contact", label: "Contacts", hint: "Shown when you expand a contact row" },
];
const TYPES: { id: CustomFieldType; label: string }[] = [
  { id: "text", label: "Text" }, { id: "number", label: "Number" }, { id: "date", label: "Date" }, { id: "select", label: "Dropdown" }, { id: "checkbox", label: "Checkbox" }, { id: "url", label: "URL" }, { id: "user", label: "Person" },
];

export function CustomFieldSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const [entity, setEntity] = useState<CustomFieldEntity>("task");
  const { data: defs = [] } = useQuery({ queryKey: ["custom-field-defs", entity], queryFn: () => api.getCustomFieldDefs(entity) });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["custom-field-defs"] }); qc.invalidateQueries({ queryKey: ["custom-field-values"] }); };
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [options, setOptions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createCustomField({ entityType: entity, name: name.trim(), type, options: type === "select" ? options.split(",").map((o) => o.trim()).filter(Boolean) : undefined }),
    onSuccess: () => { setName(""); setOptions(""); setError(null); invalidate(); },
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({ mutationFn: ({ id, ...b }: { id: string } & Parameters<typeof api.updateCustomField>[1]) => api.updateCustomField(id, b), onSuccess: invalidate, onError: (e: Error) => setError(e.message) });
  const archive = useMutation({ mutationFn: (id: string) => api.archiveCustomField(id), onSuccess: invalidate, onError: (e: Error) => setError(e.message) });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.reorderCustomFields(entity, ids), onSuccess: invalidate });
  const move = (i: number, dir: -1 | 1) => {
    const ids = defs.map((d) => d.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  };
  const field = "rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-60";
  const meta = ENTITIES.find((e) => e.id === entity)!;

  return (
    <div className="max-w-2xl" data-testid="custom-field-settings">
      <h1 className="text-lg font-semibold text-slate-900">Custom fields</h1>
      <p className="mt-1 text-sm text-muted-foreground">Track what matters to you on tasks, projects and contacts. Fields appear on every record of that type; archiving hides a field without losing what was typed.</p>
      <div className="mt-4 flex gap-1">
        {ENTITIES.map((e) => (
          <button key={e.id} type="button" onClick={() => setEntity(e.id)} className={cn("rounded-full border px-3 py-1 text-xs font-medium", entity === e.id ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:border-slate-300")}>
            {e.label}
          </button>
        ))}
        <span className="ml-2 self-center text-[11px] text-muted-foreground">{meta.hint}</span>
      </div>
      <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-white">
        {defs.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No fields on {meta.label.toLowerCase()} yet.</li>}
        {defs.map((d: CustomFieldDef, i) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            {canEdit && (
              <span className="flex flex-col text-[9px] leading-none text-slate-400">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="hover:text-slate-700 disabled:opacity-30">▲</button>
                <button type="button" disabled={i === defs.length - 1} onClick={() => move(i, 1)} className="hover:text-slate-700 disabled:opacity-30">▼</button>
              </span>
            )}
            <input key={d.name} defaultValue={d.name} disabled={!canEdit} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== d.name && update.mutate({ id: d.id, name: e.target.value.trim() })} className={`${field} w-48 py-1`} aria-label="Field name" />
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{TYPES.find((t) => t.id === d.type)?.label ?? d.type}</span>
            {d.type === "select" && (
              <input key={(d.options ?? []).join("|")} defaultValue={(d.options ?? []).join(", ")} disabled={!canEdit} onBlur={(e) => update.mutate({ id: d.id, options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })} className={`${field} min-w-[12rem] flex-1 py-1 text-xs`} title="Options, comma-separated" aria-label="Options" />
            )}
            <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-600">
              <input type="checkbox" checked={d.required} disabled={!canEdit} onChange={(e) => update.mutate({ id: d.id, required: e.target.checked })} className="accent-indigo-600" /> required
            </label>
            {canEdit && <button type="button" onClick={() => archive.mutate(d.id)} className="text-xs text-slate-400 hover:text-red-600">Archive</button>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }} className="mt-3 flex flex-wrap items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`New ${meta.label.toLowerCase().slice(0, -1)} field, e.g. ${entity === "contact" ? "LinkedIn" : entity === "project" ? "PO number" : "Story points"}`} className={`${field} w-64`} />
          <select value={type} onChange={(e) => setType(e.target.value as CustomFieldType)} className={field} aria-label="Type">
            {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          {type === "select" && <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Options, comma-separated" className={`${field} w-56`} />}
          <button type="submit" disabled={!name.trim() || create.isPending || (type === "select" && !options.trim())} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Add field</button>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
