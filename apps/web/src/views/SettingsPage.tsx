import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Status } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { PRIORITY } from "../components/ui.js";
import type { Priority } from "../lib/api.js";

/**
 * Workspace settings. Sections are added as the roadmap lands; each one is a
 * self-contained panel that owns its own queries.
 */
type Section = "statuses" | "priorities";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "statuses", label: "Task statuses", hint: "Per space: names, colours, order, done state" },
  { id: "priorities", label: "Priorities", hint: "The four priority levels" },
];

export function SettingsPage() {
  const { role } = useAuth();
  const canEdit = role === "owner" || role === "admin";
  const [section, setSection] = useState<Section>("statuses");

  return (
    <div className="flex h-screen flex-1 overflow-hidden">
      <aside className="w-60 shrink-0 border-r border-border bg-white">
        <p className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Settings</p>
        <nav className="px-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${section === s.id ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-muted"}`}
            >
              {s.label}
              <span className="block text-[11px] font-normal text-muted-foreground">{s.hint}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          {!canEdit && (
            <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              You can view these settings. Only owners and admins can change them.
            </p>
          )}
          {section === "statuses" && <StatusSettings canEdit={canEdit} />}
          {section === "priorities" && <PrioritySettings />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Task statuses (per space)
 * ------------------------------------------------------------------ */
const CATEGORY_LABEL: Record<Status["category"], string> = {
  not_started: "Not started",
  active: "Active",
  done: "Done",
  closed: "Closed",
};
const STATUS_COLORS = ["#94a3b8", "#3b82f6", "#f59e0b", "#22c55e", "#8b5cf6", "#ec4899", "#ef4444", "#14b8a6", "#64748b"];

function StatusSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces });
  const [spaceId, setSpaceId] = useState("");
  useEffect(() => {
    if (!spaceId && spaces[0]) setSpaceId(spaces[0].id);
  }, [spaces, spaceId]);
  const { data: statuses = [] } = useQuery({
    queryKey: ["statuses", spaceId],
    queryFn: () => api.getStatuses(spaceId),
    enabled: Boolean(spaceId),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["statuses", spaceId] });

  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Status | null>(null);
  const [reassignTo, setReassignTo] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createStatus(spaceId, { name: newName.trim(), color: STATUS_COLORS[statuses.length % STATUS_COLORS.length] }),
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.updateStatus>[1]) => api.updateStatus(id, body),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.reorderStatuses(spaceId, ids),
    onSuccess: (rows) => qc.setQueryData(["statuses", spaceId], rows),
  });
  const remove = useMutation({
    mutationFn: ({ id, to }: { id: string; to?: string }) => api.deleteStatus(id, to),
    onSuccess: () => {
      setDeleting(null);
      setReassignTo("");
      invalidate();
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const move = (index: number, dir: -1 | 1) => {
    const ids = statuses.map((s) => s.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate(ids);
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Task statuses</h1>
          <p className="text-xs text-muted-foreground">
            Each space has its own set. Tasks in a “Done” status count as complete everywhere.
          </p>
        </div>
        <select
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
          className="ml-auto rounded-md border border-border bg-white px-2 py-1 text-sm"
        >
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mb-3 flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-3 text-red-500">
            ✕
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-white">
        {statuses.map((s, i) => (
          <div key={s.id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
            <div className="flex flex-col text-[10px] leading-none text-slate-400">
              <button type="button" disabled={!canEdit || i === 0} onClick={() => move(i, -1)} className="hover:text-slate-700 disabled:opacity-30">
                ▲
              </button>
              <button type="button" disabled={!canEdit || i === statuses.length - 1} onClick={() => move(i, 1)} className="hover:text-slate-700 disabled:opacity-30">
                ▼
              </button>
            </div>
            <label className="relative h-5 w-5 shrink-0 cursor-pointer rounded-full ring-1 ring-black/10" style={{ background: s.color }} title="Colour">
              <input
                type="color"
                value={s.color}
                disabled={!canEdit}
                onChange={(e) => update.mutate({ id: s.id, color: e.target.value })}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
            <InlineName value={s.name} disabled={!canEdit} onCommit={(name) => update.mutate({ id: s.id, name })} />
            <select
              value={s.category}
              disabled={!canEdit}
              onChange={(e) => update.mutate({ id: s.id, category: e.target.value as Status["category"] })}
              className="rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
            >
              {(Object.keys(CATEGORY_LABEL) as Status["category"][]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!canEdit || statuses.length <= 1}
              onClick={() => setDeleting(s)}
              className="ml-1 text-xs text-slate-400 hover:text-red-500 disabled:opacity-30"
            >
              Delete
            </button>
          </div>
        ))}
        {canEdit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) create.mutate();
            }}
            className="flex items-center gap-2 bg-muted/40 px-3 py-2"
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New status name…"
              className="flex-1 rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:border-indigo-400"
            />
            <button type="submit" disabled={!newName.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
              Add status
            </button>
          </form>
        )}
      </div>

      {deleting && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={() => setDeleting(null)}>
          <div className="w-96 rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-slate-900">Delete “{deleting.name}”?</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Tasks that use this status will be moved to the status you pick below.
            </p>
            <select
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              className="mt-3 w-full rounded-md border border-border bg-white px-2 py-1 text-sm"
            >
              <option value="">Move tasks to…</option>
              {statuses
                .filter((s) => s.id !== deleting.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleting(null)} className="rounded-md px-3 py-1.5 text-xs text-slate-600 hover:bg-muted">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => remove.mutate({ id: deleting.id, to: reassignTo || undefined })}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
              >
                Delete status
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineName({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() && text.trim() !== value && onCommit(text.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-slate-800 hover:border-border focus:border-indigo-400 focus:outline-none disabled:text-slate-600"
    />
  );
}

/* ------------------------------------------------------------------ *
 * Priorities — fixed set, shown for reference
 * ------------------------------------------------------------------ */
function PrioritySettings() {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Priorities</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        Four levels, shared by every space so cross-project views stay comparable.
      </p>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        {(Object.keys(PRIORITY) as Priority[]).map((p) => (
          <div key={p} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
            <span className={`inline-flex h-5 w-5 items-center justify-center rounded ${PRIORITY[p].color} ${PRIORITY[p].text} text-[10px] font-bold`}>
              !
            </span>
            <span className="text-sm text-slate-800">{PRIORITY[p].label}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
