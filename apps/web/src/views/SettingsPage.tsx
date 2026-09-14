import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DealStageRow, type StageTemplate, type Status, type Tag, type TaskTemplate } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { PRIORITY } from "../components/ui.js";
import type { Priority } from "../lib/api.js";

/**
 * Workspace settings. Sections are added as the roadmap lands; each one is a
 * self-contained panel that owns its own queries.
 */
type Section = "statuses" | "priorities" | "stages" | "tags" | "templates" | "dealstages";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "statuses", label: "Task statuses", hint: "Per space: names, colours, order, done state" },
  { id: "priorities", label: "Priorities", hint: "The four priority levels" },
  { id: "stages", label: "Stage templates", hint: "Default stage sequences for new projects" },
  { id: "tags", label: "Tags", hint: "Workspace tags: rename, recolour, merge, retire" },
  { id: "templates", label: "Task list templates", hint: "Saved task sets to kick off new projects" },
  { id: "dealstages", label: "Deal stages", hint: "Pipeline columns: rename, reorder, mark won/lost" },
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
          {section === "stages" && <StageTemplateSettings canEdit={canEdit} />}
          {section === "tags" && <TagSettings canEdit={canEdit} />}
          {section === "templates" && <TaskTemplateSettings canEdit={canEdit} />}
          {section === "dealstages" && <DealStageSettings canEdit={canEdit} />}
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

/* ------------------------------------------------------------------ *
 * Stage templates — reusable sequences; the default is applied to new projects
 * ------------------------------------------------------------------ */
function StageTemplateSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ["stage-templates"], queryFn: api.getStageTemplates });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["stage-templates"] });
  const [name, setName] = useState("");
  const [stagesText, setStagesText] = useState("");
  const create = useMutation({
    mutationFn: () => api.createStageTemplate({ name: name.trim(), stages: splitStages(stagesText) }),
    onSuccess: () => {
      setName("");
      setStagesText("");
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.updateStageTemplate>[1]) => api.updateStageTemplate(id, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteStageTemplate(id), onSuccess: invalidate });

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Stage templates</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        Each template is an ordered list of stages. The default one is added to every new project; any template can be
        applied to an existing project from its page.
      </p>
      <div className="space-y-3">
        {templates.map((t) => (
          <TemplateRow key={t.id} template={t} canEdit={canEdit} onSave={(body) => update.mutate({ id: t.id, ...body })} onDelete={() => remove.mutate(t.id)} />
        ))}
      </div>
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && splitStages(stagesText).length) create.mutate();
          }}
          className="mt-4 rounded-lg border border-dashed border-border p-3"
        >
          <p className="mb-2 text-xs font-medium text-slate-700">New template</p>
          <div className="flex flex-col gap-2 md:flex-row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Website build)" className="rounded-md border border-border px-2 py-1 text-sm outline-none focus:border-indigo-400 md:w-48" />
            <input value={stagesText} onChange={(e) => setStagesText(e.target.value)} placeholder="Stages, comma-separated: Discovery, Design, Build, QA, Launch" className="flex-1 rounded-md border border-border px-2 py-1 text-sm outline-none focus:border-indigo-400" />
            <button type="submit" disabled={!name.trim() || !splitStages(stagesText).length || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
              Add template
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function splitStages(text: string) {
  return text.split(/[,\n>›]/).map((s) => s.trim()).filter(Boolean);
}

function TemplateRow({ template, canEdit, onSave, onDelete }: { template: StageTemplate; canEdit: boolean; onSave: (b: { name?: string; stages?: string[]; isDefault?: boolean }) => void; onDelete: () => void }) {
  const [name, setName] = useState(template.name);
  const [stagesText, setStagesText] = useState(template.stages.join(", "));
  useEffect(() => {
    setName(template.name);
    setStagesText(template.stages.join(", "));
  }, [template.name, template.stages]);
  const dirty = name.trim() !== template.name || splitStages(stagesText).join("|") !== template.stages.join("|");
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <div className="flex items-center gap-2">
        <input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} className="w-48 rounded-md border border-transparent px-2 py-1 text-sm font-semibold text-slate-900 hover:border-border focus:border-indigo-400 focus:outline-none" />
        {template.isDefault ? (
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">Default for new projects</span>
        ) : (
          canEdit && (
            <button type="button" onClick={() => onSave({ isDefault: true })} className="text-[11px] text-slate-500 hover:text-indigo-700">
              Make default
            </button>
          )
        )}
        {canEdit && (
          <button type="button" onClick={onDelete} className="ml-auto text-[11px] text-slate-400 hover:text-red-500">
            Delete
          </button>
        )}
      </div>
      <input value={stagesText} disabled={!canEdit} onChange={(e) => setStagesText(e.target.value)} className="mt-2 w-full rounded-md border border-border px-2 py-1 text-sm text-slate-700 outline-none focus:border-indigo-400 disabled:bg-muted/40" />
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {splitStages(stagesText).map((st, i) => (
          <span key={i} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-slate-700">
            {i + 1}. {st}
          </span>
        ))}
        {canEdit && dirty && (
          <button type="button" onClick={() => onSave({ name: name.trim(), stages: splitStages(stagesText) })} className="ml-auto rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white">
            Save changes
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tags — one workspace-wide set used across every project
 * ------------------------------------------------------------------ */
const TAG_PALETTE = ["#6366f1", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#64748b", "#ec4899", "#14b8a6"];

function TagSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: tags = [] } = useQuery({ queryKey: ["tags", "usage"], queryFn: () => api.getTags({ usage: true }) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tags"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const [newName, setNewName] = useState("");
  const [merging, setMerging] = useState<Tag | null>(null);
  const [mergeInto, setMergeInto] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createTag({ name: newName.trim(), color: TAG_PALETTE[tags.length % TAG_PALETTE.length] }),
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; color?: string }) => api.updateTag(id, body),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message),
  });
  const merge = useMutation({
    mutationFn: ({ id, into }: { id: string; into: string }) => api.mergeTag(id, into),
    onSuccess: () => {
      setMerging(null);
      setMergeInto("");
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });
  const retire = useMutation({ mutationFn: (id: string) => api.retireTag(id), onSuccess: invalidate, onError: (e: Error) => setError(e.message) });

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Tags</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        One colour-coded set for the whole workspace (bug, design, client-review…), so filters mean the same thing in every project.
        Retired tags disappear from pickers; merging moves every task to the other tag.
      </p>
      {error && (
        <div className="mb-3 flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-3 text-red-500">✕</button>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        {tags.map((t) => (
          <div key={t.id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
            <label className="relative h-5 w-5 shrink-0 cursor-pointer rounded-full ring-1 ring-black/10" style={{ background: t.color }} title="Colour">
              <input type="color" value={t.color} disabled={!canEdit} onChange={(e) => update.mutate({ id: t.id, color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" />
            </label>
            <InlineName value={t.name} disabled={!canEdit} onCommit={(name) => update.mutate({ id: t.id, name })} />
            <span className="w-20 text-right text-[11px] text-muted-foreground">
              {t.taskCount ?? 0} task{(t.taskCount ?? 0) === 1 ? "" : "s"}
            </span>
            {canEdit && (
              <>
                <button type="button" onClick={() => setMerging(t)} className="text-xs text-slate-500 hover:text-indigo-700">Merge…</button>
                <button type="button" onClick={() => retire.mutate(t.id)} className="text-xs text-slate-400 hover:text-red-500">Retire</button>
              </>
            )}
          </div>
        ))}
        {!tags.length && <p className="px-3 py-3 text-xs text-muted-foreground">No tags yet.</p>}
        {canEdit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) create.mutate();
            }}
            className="flex items-center gap-2 bg-muted/40 px-3 py-2"
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New tag (e.g. client-review)…" className="flex-1 rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:border-indigo-400" />
            <button type="submit" disabled={!newName.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">Add tag</button>
          </form>
        )}
      </div>

      {merging && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={() => setMerging(null)}>
          <div className="w-96 rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-slate-900">Merge “{merging.name}” into…</h2>
            <p className="mt-1 text-xs text-muted-foreground">Every task tagged “{merging.name}” gets the tag you pick, and “{merging.name}” is retired.</p>
            <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} className="mt-3 w-full rounded-md border border-border bg-white px-2 py-1 text-sm">
              <option value="">Choose a tag…</option>
              {tags.filter((t) => t.id !== merging.id).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setMerging(null)} className="rounded-md px-3 py-1.5 text-xs text-slate-600 hover:bg-muted">Cancel</button>
              <button type="button" disabled={!mergeInto} onClick={() => merge.mutate({ id: merging.id, into: mergeInto })} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                Merge tags
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Task list templates — saved from any list, applied from a project page
 * ------------------------------------------------------------------ */
function TaskTemplateSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ["task-templates"], queryFn: api.getTaskTemplates });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["task-templates"] });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; description?: string | null }) => api.updateTaskTemplate(id, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteTaskTemplate(id), onSuccess: invalidate });
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Task list templates</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        Save any list as a template from its toolbar (“Save as template”), then apply it from a project page. Due dates are
        stored as offsets from the project start, so a “Website build” template schedules itself around each new project.
      </p>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        {templates.map((t) => (
          <TemplateSettingsRow key={t.id} template={t} canEdit={canEdit} onSave={(body) => update.mutate({ id: t.id, ...body })} onDelete={() => remove.mutate(t.id)} />
        ))}
        {!templates.length && <p className="px-3 py-3 text-xs text-muted-foreground">No templates yet. Open a list and use “Save as template”.</p>}
      </div>
    </div>
  );
}

function TemplateSettingsRow({ template, canEdit, onSave, onDelete }: { template: TaskTemplate; canEdit: boolean; onSave: (b: { name?: string; description?: string | null }) => void; onDelete: () => void }) {
  const [desc, setDesc] = useState(template.description ?? "");
  useEffect(() => setDesc(template.description ?? ""), [template.description]);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <InlineName value={template.name} disabled={!canEdit} onCommit={(name) => onSave({ name })} />
      <span className="text-[11px] text-muted-foreground">
        {template.taskCount} tasks · {template.subtaskCount} subtasks · {template.milestoneCount} milestones
      </span>
      <input
        value={desc}
        disabled={!canEdit}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={() => desc !== (template.description ?? "") && onSave({ description: desc || null })}
        placeholder="Description (optional)"
        className="w-64 rounded-md border border-border px-2 py-1 text-xs outline-none focus:border-indigo-400 disabled:bg-muted/40"
      />
      {canEdit && (
        <button type="button" onClick={onDelete} className="ml-auto text-xs text-slate-400 hover:text-red-500">
          Delete
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Deal stages (row 53)
 * ------------------------------------------------------------------ */
const KIND_LABEL: Record<DealStageRow["kind"], string> = { open: "Open", won: "Won", lost: "Lost" };

function DealStageSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: stages = [] } = useQuery({ queryKey: ["deal-stages"], queryFn: api.getDealStages });
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<DealStageRow | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["deal-stages"] });
    qc.invalidateQueries({ queryKey: ["deal-board"] });
    qc.invalidateQueries({ queryKey: ["deals"] });
    setError(null);
  };
  const fail = (e: unknown) => setError((e as Error).message.replace(/^API \d+: /, ""));
  const create = useMutation({ mutationFn: () => api.createDealStage({ name }), onSuccess: () => { setName(""); refresh(); }, onError: fail });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateDealStage>[1] }) => api.updateDealStage(id, body), onSuccess: refresh, onError: fail });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.reorderDealStages(ids), onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: ({ id, to }: { id: string; to?: string }) => api.deleteDealStage(id, to), onSuccess: () => { setDeleting(null); refresh(); }, onError: fail });

  function swap(i: number, j: number) {
    if (j < 0 || j >= stages.length) return;
    const ids = stages.map((s) => s.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  }

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Deal stages</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The columns of the pipeline board, in order. Mark which stages mean <b>Won</b> and <b>Lost</b>; deals entering a stage take its default probability.
      </p>
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <ul className="mt-5 divide-y divide-border rounded-lg border border-border bg-white">
        {stages.map((st, i) => (
          <li key={st.id} className="flex items-center gap-3 px-3 py-2">
            <div className="flex flex-col text-[10px] leading-none text-slate-400">
              <button type="button" disabled={!canEdit || i === 0} onClick={() => swap(i, i - 1)} className="hover:text-slate-700 disabled:opacity-30">▲</button>
              <button type="button" disabled={!canEdit || i === stages.length - 1} onClick={() => swap(i, i + 1)} className="hover:text-slate-700 disabled:opacity-30">▼</button>
            </div>
            <label className="relative h-5 w-5 shrink-0 cursor-pointer rounded-full ring-1 ring-black/10" style={{ background: st.color }} title="Colour">
              <input type="color" value={st.color} disabled={!canEdit} onChange={(e) => update.mutate({ id: st.id, body: { color: e.target.value } })} className="absolute inset-0 cursor-pointer opacity-0" />
            </label>
            <InlineName value={st.name} disabled={!canEdit} onCommit={(v) => update.mutate({ id: st.id, body: { name: v } })} />
            <select value={st.kind} disabled={!canEdit} onChange={(e) => update.mutate({ id: st.id, body: { kind: e.target.value as DealStageRow["kind"] } })} className="rounded-md border border-border bg-white px-2 py-1 text-xs">
              {(Object.keys(KIND_LABEL) as DealStageRow["kind"][]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input type="number" min={0} max={100} defaultValue={st.probability} disabled={!canEdit} onBlur={(e) => Number(e.target.value) !== st.probability && update.mutate({ id: st.id, body: { probability: Number(e.target.value) } })} className="w-14 rounded-md border border-border px-1.5 py-1 text-xs" />
              %
            </label>
            {canEdit && (
              <button type="button" onClick={() => { setDeleting(st); setMoveTo(""); }} className="ml-auto text-xs text-slate-400 hover:text-red-600">
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="mt-3 flex gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New stage, e.g. Discovery call" className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm outline-none focus:border-indigo-500" />
          <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            Add stage
          </button>
        </form>
      )}
      {deleting && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setDeleting(null)} />
          <div className="fixed left-1/2 top-1/2 z-50 w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
            <h2 className="text-sm font-semibold text-slate-900">Delete “{deleting.name}”?</h2>
            <p className="mt-1 text-xs text-muted-foreground">Deals in this stage move to:</p>
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="mt-2 w-full rounded-md border border-border px-2 py-1.5 text-sm">
              <option value="">First open stage</option>
              {stages.filter((s) => s.id !== deleting.id).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleting(null)} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
              <button type="button" onClick={() => remove.mutate({ id: deleting.id, to: moveTo || undefined })} disabled={remove.isPending} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                Delete stage
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
