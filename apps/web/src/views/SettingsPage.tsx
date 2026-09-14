import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DealStageRow, type DocTemplate, type ProposalTemplate, type Snippet, type StageTemplate, type Status, type Tag, type TaskTemplate } from "../lib/api.js";
import { ProposalSectionsEditor } from "../components/ProposalSections.js";
import { DocEditor } from "../components/doc/DocEditor.js";
import { useAuth } from "../lib/auth.js";
import { MfaEnroll } from "./MfaPages.js";
import { ASSIGNABLE_ROLES, PERMISSION_MATRIX, ROLE_DESCRIPTIONS, ROLE_LABELS, type WorkspaceRole } from "../lib/roles.js";
import type { ReminderSlot } from "../lib/api.js";
import { supabase } from "../lib/supabase.js";
import { PRIORITY, PRIORITY_DEFAULTS, PRIORITY_PALETTE, applyPriorityConfig } from "../components/ui.js";
import { applyBranding } from "../lib/brand.js";
import { WorkCalendarSettings } from "../components/WorkCalendarSettings.js";
import { NotificationDefaultsSettings } from "../components/NotificationDefaultsSettings.js";
import type { Priority } from "../lib/api.js";

/**
 * Workspace settings. Sections are added as the roadmap lands; each one is a
 * self-contained panel that owns its own queries.
 */
type Section = "people" | "workhours" | "notifications" | "timecodes" | "statuses" | "priorities" | "stages" | "tags" | "templates" | "dealstages" | "proposals" | "snippets" | "branding" | "dockit" | "sso" | "security";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "people", label: "People & roles", hint: "Who's in the workspace and what each role can do" },
  { id: "statuses", label: "Task statuses", hint: "Per space: names, colours, order, done state" },
  { id: "workhours", label: "Working hours & holidays", hint: "Standard week, days off, and each person's hours" },
  { id: "notifications", label: "Notifications", hint: "Defaults for new members, and workspace quiet hours" },
  { id: "timecodes", label: "Time codes & reminders", hint: "Internal codes, and when to nudge unfinished timesheets" },
  { id: "priorities", label: "Priorities", hint: "The four priority levels" },
  { id: "stages", label: "Stage templates", hint: "Default stage sequences for new projects" },
  { id: "tags", label: "Tags", hint: "Workspace tags: rename, recolour, merge, retire" },
  { id: "templates", label: "Task list templates", hint: "Saved task sets to kick off new projects" },
  { id: "dealstages", label: "Deal stages", hint: "Pipeline columns: rename, reorder, mark won/lost" },
  { id: "proposals", label: "Proposal templates", hint: "Fixed sections every proposal starts from" },
  { id: "snippets", label: "Snippets", hint: "Reusable doc content that stays in sync" },
  { id: "branding", label: "Branding", hint: "Colour, logo and footer on PDFs and client pages" },
  { id: "sso", label: "Sign-in & SSO", hint: "Google Workspace domain that auto-joins" },
  { id: "security", label: "Security & 2FA", hint: "Authenticator app, backup codes, who must use it" },
  { id: "dockit", label: "Doc starter kit", hint: "Docs every new project starts with" },
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
          {section === "people" && <PeopleSettings canEdit={canEdit} />}
          {section === "workhours" && <WorkCalendarSettings canEdit={canEdit} />}
          {section === "notifications" && <NotificationDefaultsSettings canEdit={canEdit} />}
          {section === "timecodes" && <TimeCodeSettings canEdit={canEdit} />}
          {section === "priorities" && <PrioritySettings canEdit={canEdit} />}
          {section === "stages" && <StageTemplateSettings canEdit={canEdit} />}
          {section === "tags" && <TagSettings canEdit={canEdit} />}
          {section === "templates" && <TaskTemplateSettings canEdit={canEdit} />}
          {section === "dealstages" && <DealStageSettings canEdit={canEdit} />}
          {section === "proposals" && <ProposalTemplateSettings canEdit={canEdit} />}
          {section === "snippets" && <SnippetSettings canEdit={canEdit} />}
          {section === "branding" && <BrandingSettings canEdit={canEdit} />}
          {section === "sso" && <SsoSettings canEdit={canEdit} />}
          {section === "security" && <SecuritySettings canEdit={canEdit} />}
          {section === "dockit" && <DocKitSettings canEdit={canEdit} />}
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
function PrioritySettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: cfg } = useQuery({ queryKey: ["priorities"], queryFn: api.getPriorities });
  const [draft, setDraft] = useState<Partial<Record<Priority, { label: string; color: string }>>>({});
  const save = useMutation({
    mutationFn: () => api.updatePriorities(draft),
    onSuccess: (next) => {
      qc.setQueryData(["priorities"], next);
      applyPriorityConfig(next);
      setDraft({});
    },
  });
  const [, force] = useState(0);
  const current = (p: Priority) => draft[p] ?? cfg?.[p] ?? PRIORITY_DEFAULTS[p];
  const set = (p: Priority, patch: Partial<{ label: string; color: string }>) => setDraft((d) => ({ ...d, [p]: { ...current(p), ...patch } }));
  const dirty = Object.keys(draft).length > 0;
  const reset = useMutation({
    mutationFn: () => api.updatePriorities(PRIORITY_DEFAULTS),
    onSuccess: (next) => { qc.setQueryData(["priorities"], next); applyPriorityConfig(next); setDraft({}); force((n) => n + 1); },
  });
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Priorities</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        Four levels, shared by every space so cross-project views stay comparable. Rename them and pick a colour; the keys (urgent / high / normal / low) stay fixed so sorting, quick-add shortcuts and imports keep working.
      </p>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        {(Object.keys(PRIORITY_DEFAULTS) as Priority[]).map((p) => {
          const c = current(p);
          const pal = PRIORITY_PALETTE[c.color] ?? PRIORITY_PALETTE.slate!;
          return (
            <div key={p} className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
              <span className={`inline-flex h-5 w-5 items-center justify-center rounded ${pal.color} text-[10px] font-bold text-white`}>!</span>
              <input
                value={c.label}
                disabled={!canEdit}
                maxLength={24}
                onChange={(e) => set(p, { label: e.target.value })}
                className="w-40 rounded-md border border-border bg-white px-2 py-1 text-sm text-slate-800 outline-none focus:border-indigo-400 disabled:opacity-60"
                aria-label={`${p} label`}
              />
              <span className="text-[11px] text-muted-foreground">{p}</span>
              <div className="ml-auto flex items-center gap-1">
                {Object.entries(PRIORITY_PALETTE).map(([name, pp]) => (
                  <button
                    key={name}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => set(p, { color: name })}
                    title={name}
                    aria-label={`${p} colour ${name}`}
                    className={`h-4 w-4 rounded-full border-2 ${c.color === name ? "border-slate-800" : "border-transparent"} disabled:opacity-60`}
                    style={{ background: pp.swatch }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            Save
          </button>
          {dirty && <button type="button" onClick={() => setDraft({})} className="text-sm text-muted-foreground hover:text-slate-700">Discard</button>}
          <button type="button" onClick={() => reset.mutate()} className="ml-auto text-xs text-muted-foreground hover:text-slate-700">Reset to defaults</button>
        </div>
      )}
      {(save.isError || reset.isError) && <p className="mt-2 text-xs text-red-600">{((save.error ?? reset.error) as Error).message}</p>}
      <p className="mt-4 text-[11px] text-muted-foreground">Preview: {(Object.keys(PRIORITY) as Priority[]).map((p) => <span key={p} className={`mr-2 ${PRIORITY[p].text}`}>● {PRIORITY[p].label}</span>)}</p>
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

/* ------------------------------------------------------------------ *
 * Proposal templates (row 56)
 * ------------------------------------------------------------------ */
function ProposalTemplateSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ["proposal-templates"], queryFn: api.getProposalTemplates });
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["proposal-templates"] });
  const create = useMutation({ mutationFn: () => api.createProposalTemplate({ name }), onSuccess: (t) => { setName(""); setOpenId(t.id); refresh(); } });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateProposalTemplate>[1] }) => api.updateProposalTemplate(id, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteProposalTemplate(id), onSuccess: refresh });
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Proposal templates</h1>
      <p className="mt-1 text-sm text-muted-foreground">Each template is a fixed set of sections — scope, milestones, timeline, exclusions, assumptions, terms — with boilerplate you tweak per deal.</p>
      <ul className="mt-5 space-y-2">
        {templates.map((t) => (
          <ProposalTemplateRow key={t.id} template={t} open={openId === t.id} canEdit={canEdit} onToggle={() => setOpenId(openId === t.id ? null : t.id)} onSave={(b) => update.mutate({ id: t.id, body: b })} onDelete={() => window.confirm(`Delete “${t.name}”?`) && remove.mutate(t.id)} />
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New template, e.g. Retainer" className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm outline-none focus:border-indigo-500" />
          <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            Add template
          </button>
        </form>
      )}
    </div>
  );
}

function ProposalTemplateRow({ template, open, canEdit, onToggle, onSave, onDelete }: { template: ProposalTemplate; open: boolean; canEdit: boolean; onToggle: () => void; onSave: (b: Parameters<typeof api.updateProposalTemplate>[1]) => void; onDelete: () => void }) {
  const [sections, setSections] = useState(template.sections);
  useEffect(() => setSections(template.sections), [template]);
  const dirty = JSON.stringify(sections) !== JSON.stringify(template.sections);
  return (
    <li className="rounded-lg border border-border bg-white">
      <div className="flex items-center gap-3 px-3 py-2">
        <button type="button" onClick={onToggle} className="text-xs text-slate-400">{open ? "▾" : "▸"}</button>
        <InlineName value={template.name} disabled={!canEdit} onCommit={(v) => onSave({ name: v })} />
        <span className="text-xs text-muted-foreground">{template.sections.length} sections</span>
        {template.isDefault ? (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">Default</span>
        ) : (
          canEdit && (
            <button type="button" onClick={() => onSave({ isDefault: true })} className="text-[11px] text-slate-500 hover:text-indigo-700">
              Make default
            </button>
          )
        )}
        {canEdit && (
          <button type="button" onClick={onDelete} className="ml-auto text-xs text-slate-400 hover:text-red-600">
            Delete
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-border bg-[#fbfbfa] p-3">
          <ProposalSectionsEditor sections={sections} onChange={setSections} disabled={!canEdit} />
          {canEdit && dirty && (
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setSections(template.sections)} className="rounded-md px-3 py-1.5 text-xs text-slate-600 hover:bg-muted">Discard</button>
              <button type="button" onClick={() => onSave({ sections })} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save sections</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Snippets (row 66)
 * ------------------------------------------------------------------ */
function SnippetSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: snippets = [] } = useQuery({ queryKey: ["snippets"], queryFn: api.getSnippets });
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["snippets"] });
    qc.invalidateQueries({ queryKey: ["snippet"] });
  };
  const create = useMutation({
    mutationFn: () => api.createSnippet({ name, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Write the reusable text here…" }] }] } }),
    onSuccess: (s) => {
      setName("");
      setOpenId(s.id);
      refresh();
    },
  });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateSnippet>[1] }) => api.updateSnippet(id, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteSnippet(id), onSuccess: refresh });
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Snippets</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Boilerplate you reuse across docs — scope wording, terms, team bios. Insert one with <code>/snippet</code> or select text in a doc and press “⟲ Snippet”. Edits here update every doc that embeds it.
      </p>
      <ul className="mt-5 space-y-2">
        {snippets.map((sn) => (
          <li key={sn.id} className="rounded-lg border border-border bg-white">
            <div className="flex items-center gap-3 px-3 py-2">
              <button type="button" onClick={() => setOpenId(openId === sn.id ? null : sn.id)} className="text-xs text-slate-400">{openId === sn.id ? "▾" : "▸"}</button>
              <InlineName value={sn.name} disabled={!canEdit && false} onCommit={(v) => update.mutate({ id: sn.id, body: { name: v } })} />
              <span className="truncate text-xs text-muted-foreground">{sn.body.replace(/\s+/g, " ").slice(0, 80)}</span>
              {canEdit && (
                <button type="button" onClick={() => window.confirm(`Delete “${sn.name}”? Docs embedding it will show it as missing.`) && remove.mutate(sn.id)} className="ml-auto text-xs text-slate-400 hover:text-red-600">
                  Delete
                </button>
              )}
            </div>
            {openId === sn.id && (
              <div className="border-t border-border bg-[#fbfbfa] px-4 py-3">
                <SnippetBody snippet={sn} onSave={(patch) => update.mutate({ id: sn.id, body: patch })} />
              </div>
            )}
          </li>
        ))}
        {snippets.length === 0 && <li className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">No snippets yet.</li>}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
        className="mt-3 flex gap-2"
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New snippet, e.g. Payment terms" className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm outline-none focus:border-indigo-500" />
        <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          Add snippet
        </button>
      </form>
    </div>
  );
}

function SnippetBody({ snippet, onSave }: { snippet: Snippet; onSave: (patch: { content: Record<string, unknown>; body: string }) => void }) {
  return <DocEditor docId={`snippet-${snippet.id}`} title={snippet.name} content={snippet.content} body={snippet.body} settings={{}} onSave={onSave} />;
}

/* ------------------------------------------------------------------ *
 * Branding (row 67)
 * ------------------------------------------------------------------ */
function BrandingSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["branding"], queryFn: api.getBranding });
  const { refreshMe } = useAuth();
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.updateBranding>[0]) => api.updateBranding(body),
    onSuccess: (b, body) => {
      qc.setQueryData(["branding"], b);
      applyBranding(b);
      if (body.name) void refreshMe();
    },
  });
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const field = "w-full rounded-md border border-border px-3 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-60";
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Branding</h1>
      <p className="mt-1 text-sm text-muted-foreground">Name, accent colour, logo and favicon shape the app itself; the colour, logo and footer also appear on PDFs and on pages clients open from share links.</p>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <label className="block text-xs font-medium text-slate-600">
            Workspace name
            <input defaultValue={data.name} disabled={!canEdit} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== data.name && save.mutate({ name: e.target.value.trim() })} className={`${field} mt-1`} />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Accent colour <span className="font-normal text-muted-foreground">(buttons, links, active items)</span>
            <div className="mt-1 flex items-center gap-2">
              <input type="color" value={data.brandColor} disabled={!canEdit} onChange={(e) => save.mutate({ brandColor: e.target.value })} className="h-9 w-12 cursor-pointer rounded border border-border" />
              <input defaultValue={data.brandColor} disabled={!canEdit} onBlur={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value.trim()) && save.mutate({ brandColor: e.target.value.trim() })} className={field} />
            </div>
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Logo URL
            <input defaultValue={data.brandLogoUrl ?? ""} disabled={!canEdit} onBlur={(e) => (e.target.value.trim() || null) !== (data.brandLogoUrl ?? null) && save.mutate({ brandLogoUrl: e.target.value.trim() || null })} placeholder="https://…/logo.png" className={`${field} mt-1`} />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Favicon URL <span className="font-normal text-muted-foreground">(browser tab; blank = initials in your colour)</span>
            <input defaultValue={data.brandFaviconUrl ?? ""} disabled={!canEdit} onBlur={(e) => (e.target.value.trim() || null) !== (data.brandFaviconUrl ?? null) && save.mutate({ brandFaviconUrl: e.target.value.trim() || null })} placeholder="https://…/favicon.png" className={`${field} mt-1`} />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Footer line
            <input defaultValue={data.brandFooter ?? ""} disabled={!canEdit} onBlur={(e) => (e.target.value.trim() || null) !== (data.brandFooter ?? null) && save.mutate({ brandFooter: e.target.value.trim() || null })} placeholder="4S Digital · hello@4s.digital · +880 …" className={`${field} mt-1`} />
          </label>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <div className="flex items-center gap-3 px-4 py-4 text-white" style={{ background: data.brandColor }}>
            {data.brandLogoUrl ? <img src={data.brandLogoUrl} alt="" className="h-8 w-8 rounded bg-white/90 object-contain p-0.5" /> : <span className="flex h-8 w-8 items-center justify-center rounded bg-white/20 text-sm font-bold">{data.name.slice(0, 1)}</span>}
            <div>
              <p className="text-sm font-semibold">Project brief</p>
              <p className="text-[11px] opacity-80">{data.name} · Updated today</p>
            </div>
          </div>
          <div className="space-y-1.5 px-4 py-3 text-xs text-slate-600">
            <p className="font-semibold text-slate-800">Scope</p>
            <p>What the PDF body looks like, with your colour on the header band and callouts.</p>
            <div className="mt-2 border-t pt-1.5 text-[10px] text-slate-400" style={{ borderColor: data.brandColor }}>
              {data.brandFooter || data.name} · Page 1 of 1
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Invitations (row 83): invite by e-mail with the role pre-selected, see
 * who hasn't accepted yet, resend or revoke.
 * ------------------------------------------------------------------ */
function InviteForm() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "guest">("member");
  const [done, setDone] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => api.inviteMember({ email: email.trim(), name: name.trim() || undefined, role }),
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["invitations"] });
      setDone(m.email);
      setEmail("");
      setName("");
    },
  });
  const input = "rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim()) invite.mutate();
      }}
      className="mt-6 rounded-lg border border-border bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-800">Invite by e-mail</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">They get a link; signing in with that address drops them straight into this workspace with the role you pick.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1.4fr_1fr_160px_auto]">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" required className={input} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={input} />
        <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className={input}>
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!email.trim() || invite.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {invite.isPending ? "Sending…" : "Send invite"}
        </button>
      </div>
      {done && <p className="mt-2 text-xs text-emerald-700">Invited {done}.</p>}
      {invite.isError && <p className="mt-2 text-xs text-red-600">{(invite.error as Error).message}</p>}
    </form>
  );
}

function PendingInvitations() {
  const qc = useQueryClient();
  const { data: invites = [] } = useQuery({ queryKey: ["invitations"], queryFn: api.getInvitations });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["invitations"] });
    qc.invalidateQueries({ queryKey: ["members"] });
  };
  const resend = useMutation({ mutationFn: api.resendInvitation, onSuccess: refresh });
  const revoke = useMutation({ mutationFn: api.revokeInvitation, onSuccess: refresh });
  if (!invites.length) return null;
  const emailOff = invites.some((i) => !i.emailConfigured);
  return (
    <div className="mt-4 rounded-lg border border-border bg-white">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-800">Pending invitations · {invites.length}</h2>
        {emailOff && <span className="text-[11px] text-amber-700">E-mail isn't connected yet (RESEND_API_KEY) - share the invite link by hand for now.</span>}
      </div>
      <ul className="divide-y divide-border">
        {invites.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate text-slate-800">{i.email}</p>
              <p className="text-xs text-muted-foreground">
                {ROLE_LABELS[i.role as WorkspaceRole] ?? i.role} · invited {i.invitedBy ? `by ${i.invitedBy.name} ` : ""}
                {new Date(i.createdAt).toLocaleDateString()} · last sent {new Date(i.lastSentAt).toLocaleString()}
              </p>
            </div>
            <button type="button" onClick={() => resend.mutate(i.id)} disabled={resend.isPending} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted disabled:opacity-50">
              Resend
            </button>
            <button type="button" onClick={() => revoke.mutate(i.id)} disabled={revoke.isPending} className="rounded-md px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {(resend.isError || revoke.isError) && <p className="px-4 pb-2 text-xs text-red-600">{((resend.error ?? revoke.error) as Error).message}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Time codes (row 91): admin, internal, training, sales, PTO… - hours
 * logged here are never billable and need no project.
 * ------------------------------------------------------------------ */
function TimeCodeSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: codes = [] } = useQuery({ queryKey: ["time-codes", "all"], queryFn: () => api.getTimeCodes(true) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["time-codes"] });
  const [name, setName] = useState("");
  const create = useMutation({ mutationFn: () => api.createTimeCode({ name: name.trim() }), onSuccess: () => { setName(""); void refresh(); } });
  const update = useMutation({ mutationFn: ({ id, ...body }: { id: string; name?: string; color?: string; archived?: boolean }) => api.updateTimeCode(id, body), onSuccess: refresh });
  const field = "rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-60";
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Time codes</h1>
      <p className="mt-1 text-sm text-muted-foreground">Internal codes people can log hours to without a client project - so a full week is always accounted for. Time on a code is never billable.</p>
      <ul className="mt-5 max-w-xl divide-y divide-border overflow-hidden rounded-lg border border-border bg-white">
        {codes.map((c) => (
          <li key={c.id} className={`flex items-center gap-3 px-3 py-2 ${c.archived ? "opacity-50" : ""}`}>
            <input type="color" value={c.color} disabled={!canEdit} onChange={(e) => update.mutate({ id: c.id, color: e.target.value })} className="h-7 w-9 cursor-pointer rounded border border-border" title="Colour" />
            <input defaultValue={c.name} disabled={!canEdit} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && update.mutate({ id: c.id, name: e.target.value.trim() })} className={`${field} flex-1`} />
            {c.archived && <span className="text-[11px] text-muted-foreground">retired</span>}
            {canEdit && (
              <button type="button" onClick={() => update.mutate({ id: c.id, archived: !c.archived })} className="text-xs text-slate-500 hover:underline">
                {c.archived ? "Restore" : "Retire"}
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
          className="mt-3 flex max-w-xl items-center gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New code, e.g. Recruiting" className={`${field} flex-1`} />
          <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            Add code
          </button>
        </form>
      )}
      {(create.isError || update.isError) && <p className="mt-2 text-xs text-red-600">{((create.error ?? update.error) as Error).message}</p>}
      <TimesheetReminderSettings canEdit={canEdit} />
      <MilestoneRiskSettings canEdit={canEdit} />
    </div>
  );
}

/** Row 106: how many days before a milestone's target it counts as at risk (when linked tasks are open). */
function MilestoneRiskSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["milestone-risk"], queryFn: api.getMilestoneRisk });
  const [days, setDays] = useState<number | null>(null);
  const save = useMutation({ mutationFn: (d: number) => api.setMilestoneRisk(d), onSuccess: (r) => { qc.setQueryData(["milestone-risk"], r); qc.invalidateQueries({ queryKey: ["milestones-at-risk"] }); setDays(null); } });
  const value = days ?? data?.days ?? 7;
  return (
    <div className="mt-8 max-w-xl">
      <h2 className="text-sm font-semibold text-slate-800">Milestone at-risk window</h2>
      <p className="mt-1 text-xs text-muted-foreground">A milestone due within this many days that still has open linked tasks is flagged on the dashboard and sent to the project lead's inbox once.</p>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(value); }} className="mt-3 flex items-center gap-2 text-sm">
        <input type="number" min={1} max={90} value={value} disabled={!canEdit} onChange={(e) => setDays(Number(e.target.value) || 1)} className="w-20 rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-60" aria-label="Days before target" />
        <span className="text-slate-600">days before the target date</span>
        {canEdit && days != null && days !== data?.days && (
          <button type="submit" disabled={save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save</button>
        )}
      </form>
      {save.isError && <p className="mt-2 text-xs text-red-600">{(save.error as Error).message}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Missing-timesheet reminders (row 94): a schedule of nudges that only
 * reach people whose week is short of hours or not submitted.
 * ------------------------------------------------------------------ */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function TimesheetReminderSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: slots = [] } = useQuery({ queryKey: ["timesheet-reminders"], queryFn: api.getTimesheetReminders });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const [previewWeek, setPreviewWeek] = useState<"current" | "previous">("current");
  const { data: preview } = useQuery({ queryKey: ["timesheet-reminder-preview", previewWeek], queryFn: () => api.previewTimesheetReminder(previewWeek), enabled: canEdit });
  const save = useMutation({ mutationFn: (next: ReminderSlot[]) => api.setTimesheetReminders(next), onSuccess: (next) => qc.setQueryData(["timesheet-reminders"], next) });
  const sendNow = useMutation({ mutationFn: (slot: ReminderSlot) => api.sendTimesheetReminderNow(slot), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  const sel = "rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-60";
  const update = (i: number, patch: Partial<ReminderSlot>) => save.mutate(slots.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? "Someone";
  return (
    <div className="mt-8 max-w-xl">
      <h2 className="text-sm font-semibold text-slate-800">Missing-timesheet reminders</h2>
      <p className="mt-1 text-xs text-muted-foreground">Sent only to people whose week has fewer hours than their capacity or isn't submitted. Nobody who's done gets nagged.</p>
      <ul className="mt-3 space-y-2">
        {slots.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs text-slate-700">
            <select value={s.weekday} disabled={!canEdit} onChange={(e) => update(i, { weekday: Number(e.target.value) })} className={sel}>
              {DAY_NAMES.map((d, di) => (
                <option key={d} value={di}>
                  {d}
                </option>
              ))}
            </select>
            <select value={s.hour} disabled={!canEdit} onChange={(e) => update(i, { hour: Number(e.target.value) })} className={sel}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`}
                </option>
              ))}
            </select>
            <span>about</span>
            <select value={s.week} disabled={!canEdit} onChange={(e) => update(i, { week: e.target.value as ReminderSlot["week"] })} className={sel}>
              <option value="current">this week</option>
              <option value="previous">last week</option>
            </select>
            {canEdit && (
              <>
                <button type="button" onClick={() => sendNow.mutate(s)} disabled={sendNow.isPending} className="ml-auto text-indigo-600 hover:underline disabled:opacity-50" title="Send this reminder now to whoever is behind">
                  Send now
                </button>
                <button type="button" onClick={() => save.mutate(slots.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600">
                  ✕
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <button type="button" onClick={() => save.mutate([...slots, { weekday: 5, hour: 16, week: "current" }])} className="mt-2 text-xs text-indigo-600 hover:underline">
          + Add a reminder
        </button>
      )}
      {sendNow.isSuccess && <p className="mt-1 text-xs text-green-700">Sent to {sendNow.data.sent} {sendNow.data.sent === 1 ? "person" : "people"}.</p>}
      {canEdit && (
        <div className="mt-4 rounded-md border border-border bg-[#fbfbfa] p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-700">Who's behind right now</span>
            <select value={previewWeek} onChange={(e) => setPreviewWeek(e.target.value as "current" | "previous")} className={sel}>
              <option value="current">this week</option>
              <option value="previous">last week</option>
            </select>
          </div>
          {!preview ? (
            <p className="mt-1 text-muted-foreground">Checking…</p>
          ) : preview.people.length === 0 ? (
            <p className="mt-1 text-green-700">Everyone's week is complete.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-slate-700">
              {preview.people.map((p) => (
                <li key={p.userId}>
                  {nameOf(p.userId)} · {p.hours}h / {p.expected}h{p.submitted ? "" : " · not submitted"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Offboarding (row 86): one step - end date, block sign-in (everywhere,
 * instantly), stop timers, hand open tasks to someone. Nothing is deleted.
 * ------------------------------------------------------------------ */
function OffboardPanel({ member, candidates, onClose, onDone }: { member: { id: string; name: string }; candidates: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const { data: work } = useQuery({ queryKey: ["open-work", member.id], queryFn: () => api.getOpenWork(member.id) });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reassignTo, setReassignTo] = useState("");
  const go = useMutation({
    mutationFn: () => api.deactivateMember(member.id, { endDate: endDate ? new Date(`${endDate}T23:59:59`).toISOString() : null, reassignToUserId: reassignTo || null }),
    onSuccess: onDone,
  });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
      <p className="font-medium text-amber-900">Deactivate {member.name}</p>
      <p className="mt-0.5 text-xs text-amber-800">They're signed out of this workspace everywhere and can't sign back in. Their messages, docs, time entries and history stay put.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-700">
          Last day
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm" />
          <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{endDate > today ? "Access ends at the end of that day." : "Access ends right now."}</span>
        </label>
        <label className="block text-xs font-medium text-slate-700">
          Hand open tasks to
          <select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm">
            <option value="">— leave unassigned —</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3 text-xs text-slate-700">
        {!work ? (
          "Checking their open work…"
        ) : (
          <>
            <span className="font-medium">{work.openTasks.length}</span> open task{work.openTasks.length === 1 ? "" : "s"}
            {work.leadOf.length > 0 && (
              <>
                {" · "}leads <span className="font-medium">{work.leadOf.map((p) => p.name).join(", ")}</span> (pick a new lead on those projects)
              </>
            )}
            {work.timerRunning && " · a running timer will be stopped"}
          </>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={() => go.mutate()} disabled={go.isPending} className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">
          {go.isPending ? "Working…" : "Deactivate"}
        </button>
        <button type="button" onClick={onClose} className="text-xs text-slate-600 hover:underline">
          Cancel
        </button>
        {go.isError && <span className="text-xs text-red-600">{(go.error as Error).message}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * People & roles (row 82)
 * ------------------------------------------------------------------ */
function PeopleSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { role: myRole, user, refreshMe } = useAuth();
  const { data: members = [] } = useQuery({ queryKey: ["members", "all"], queryFn: api.getAllMembers });
  const refresh = () => qc.invalidateQueries({ queryKey: ["members"] });
  const setRole = useMutation({ mutationFn: ({ userId, role }: { userId: string; role: "admin" | "member" | "guest" }) => api.setMemberRole(userId, role), onSuccess: refresh });
  // Row 86: offboarding.
  const [offboarding, setOffboarding] = useState<string | null>(null);
  const reactivate = useMutation({ mutationFn: api.reactivateMember, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.removeMember, onSuccess: refresh });
  const transfer = useMutation({
    mutationFn: api.transferOwnership,
    onSuccess: async () => {
      await refresh();
      await refreshMe();
    },
  });
  const [confirmTransfer, setConfirmTransfer] = useState<string | null>(null);
  const err = (setRole.error ?? remove.error ?? transfer.error ?? reactivate.error) as Error | null;
  const sorted = [...members].sort((a, b) => ["owner", "admin", "member", "guest"].indexOf(a.role) - ["owner", "admin", "member", "guest"].indexOf(b.role) || a.name.localeCompare(b.name));

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">People &amp; roles</h1>
      <p className="mt-1 text-sm text-muted-foreground">Everyone has exactly one role in this workspace. Project access on top of that is set per project.</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(ROLE_LABELS) as WorkspaceRole[]).map((r) => (
          <div key={r} className="rounded-lg border border-border bg-white p-3">
            <p className="text-sm font-semibold text-slate-800">{ROLE_LABELS[r]}</p>
            <p className="mt-1 text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[r]}</p>
            <p className="mt-2 text-[11px] text-slate-500">{members.filter((m) => m.role === r).length} in workspace</p>
          </div>
        ))}
      </div>

      {canEdit && <InviteForm />}
      {canEdit && <PendingInvitations />}

      <div className="mt-6 overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Person</th>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((m) => (
              <tr key={m.id} className={m.accessEnded ? "opacity-60" : undefined}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">
                      {m.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-slate-800">
                        {m.name}
                        {m.id === user?.id && <span className="ml-1.5 text-[11px] text-muted-foreground">(you)</span>}
                        {m.pending && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Invited</span>}
                        {m.accessEnded && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">Deactivated{m.deactivatedAt ? ` ${new Date(m.deactivatedAt).toLocaleDateString()}` : ""}</span>}
                        {!m.accessEnded && m.endDate && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Leaves {new Date(m.endDate).toLocaleDateString()}</span>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  {m.role === "owner" || !canEdit ? (
                    <span className="text-slate-700">{ROLE_LABELS[m.role as WorkspaceRole] ?? m.role}</span>
                  ) : (
                    <select value={m.role} onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as "admin" | "member" | "guest" })} className="rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700">
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-xs">
                  {myRole === "owner" && m.role !== "owner" && !m.pending && (
                    confirmTransfer === m.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-amber-800">Make {m.name.split(" ")[0]} the owner? You become a project manager.</span>
                        <button type="button" onClick={() => { transfer.mutate(m.id); setConfirmTransfer(null); }} className="rounded-md bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-700">
                          Transfer
                        </button>
                        <button type="button" onClick={() => setConfirmTransfer(null)} className="text-slate-500 hover:underline">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setConfirmTransfer(m.id)} className="mr-3 text-slate-500 hover:text-amber-700 hover:underline">
                        Transfer ownership
                      </button>
                    )
                  )}
                  {canEdit && m.role !== "owner" && m.id !== user?.id && !m.accessEnded && !m.endDate && (
                    <button type="button" onClick={() => setOffboarding(offboarding === m.id ? null : m.id)} className="mr-3 text-slate-500 hover:text-amber-700 hover:underline" title="Block sign-in, hand over open tasks; history stays">
                      Deactivate
                    </button>
                  )}
                  {canEdit && (m.accessEnded || m.endDate) && (
                    <button type="button" onClick={() => reactivate.mutate(m.id)} className="mr-3 text-slate-500 hover:text-green-700 hover:underline">
                      Reactivate
                    </button>
                  )}
                  {canEdit && m.role !== "owner" && m.id !== user?.id && m.pending && (
                    <button type="button" onClick={() => remove.mutate(m.id)} className="text-slate-400 hover:text-red-600" title="Remove the invitation">
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {err && <p className="mt-2 text-xs text-red-600">{err.message}</p>}
      {offboarding && (
        <OffboardPanel
          member={members.find((m) => m.id === offboarding)!}
          candidates={members.filter((m) => m.id !== offboarding && !m.accessEnded && !m.pending)}
          onClose={() => setOffboarding(null)}
          onDone={() => {
            setOffboarding(null);
            void refresh();
          }}
        />
      )}

      <h2 className="mt-8 text-sm font-semibold text-slate-800">What each role can do</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-xs">
          <thead className="bg-[#fbfbfa] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Area</th>
              {(Object.keys(ROLE_LABELS) as WorkspaceRole[]).map((r) => (
                <th key={r} className="px-3 py-2 text-left font-medium">
                  {ROLE_LABELS[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {PERMISSION_MATRIX.map((row) => (
              <tr key={row.area}>
                <td className="px-3 py-2 text-slate-700">{row.area}</td>
                <td className="px-3 py-2">{row.owner}</td>
                <td className="px-3 py-2">{row.admin}</td>
                <td className="px-3 py-2">{row.member}</td>
                <td className="px-3 py-2">{row.guest}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Security & 2FA (row 81)
 * ------------------------------------------------------------------ */
const ALL_ROLES = ["owner", "admin", "member", "guest"] as const;

function SecuritySettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { refreshMe } = useAuth();
  const { data: status } = useQuery({ queryKey: ["mfa"], queryFn: api.mfaStatus });
  const { data: policy } = useQuery({ queryKey: ["mfa-policy"], queryFn: api.getMfaPolicy });
  const [enrolling, setEnrolling] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const done = async () => {
    setEnrolling(false);
    await qc.invalidateQueries({ queryKey: ["mfa"] });
    await refreshMe();
  };
  const disable = useMutation({
    mutationFn: async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      for (const f of data?.totp ?? []) await supabase.auth.mfa.unenroll({ factorId: f.id });
      return api.mfaDisable();
    },
    onSuccess: done,
  });
  const regen = useMutation({ mutationFn: api.mfaBackupCodes, onSuccess: (r) => { setFreshCodes(r.codes); void qc.invalidateQueries({ queryKey: ["mfa"] }); } });
  const savePolicy = useMutation({ mutationFn: (roles: string[]) => api.updateMfaPolicy(roles), onSuccess: (p) => qc.setQueryData(["mfa-policy"], p) });
  const required = policy?.mfaRequiredRoles ?? [];

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Security &amp; two-factor authentication</h1>
      <p className="mt-1 text-sm text-muted-foreground">A second factor from an authenticator app protects your account even if your password leaks.</p>

      <section className="mt-5 max-w-xl rounded-lg border border-border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Your account</h2>
        {!status ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : enrolling ? (
          <div className="mt-3">
            <MfaEnroll onDone={() => void done()} />
          </div>
        ) : status.enrolled ? (
          <div className="mt-2 space-y-3 text-sm">
            <p className="text-green-700">✓ Two-factor authentication is on. {status.backupCodesLeft} backup code{status.backupCodesLeft === 1 ? "" : "s"} left.</p>
            {freshCodes && (
              <ul className="grid grid-cols-2 gap-1 rounded-md border border-border bg-[#fbfbfa] p-3 font-mono text-sm text-slate-800">
                {freshCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => regen.mutate()} disabled={regen.isPending} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-muted disabled:opacity-50">
                New backup codes
              </button>
              <button type="button" onClick={() => disable.mutate()} disabled={disable.isPending} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                Turn off 2FA
              </button>
            </div>
            {(regen.isError || disable.isError) && <p className="text-xs text-red-600">{((regen.error ?? disable.error) as Error).message}</p>}
          </div>
        ) : (
          <div className="mt-2 space-y-2 text-sm">
            <p className="text-muted-foreground">Two-factor authentication is off.</p>
            <button type="button" onClick={() => setEnrolling(true)} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
              Set up authenticator app
            </button>
          </div>
        )}
      </section>

      <section className="mt-5 max-w-xl rounded-lg border border-border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Workspace policy</h2>
        <p className="mt-1 text-xs text-muted-foreground">People in these roles must set up 2FA before they can use the workspace.</p>
        <div className="mt-3 flex flex-wrap gap-3">
          {ALL_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-1.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={required.includes(role)}
                disabled={!canEdit || !policy || savePolicy.isPending}
                onChange={(e) => savePolicy.mutate(e.target.checked ? [...required, role] : required.filter((r) => r !== role))}
                className="accent-indigo-600"
              />
              {role}
            </label>
          ))}
        </div>
        {savePolicy.isError && <p className="mt-2 text-xs text-red-600">{(savePolicy.error as Error).message}</p>}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sign-in & SSO (row 80)
 * ------------------------------------------------------------------ */
function SsoSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["sso"], queryFn: api.getSso });
  const [domain, setDomain] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (v: string | null) => api.updateSso(v),
    onSuccess: (next) => {
      qc.setQueryData(["sso"], next);
      setDomain(null);
    },
  });
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const value = domain ?? data.ssoDomain ?? "";
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Sign-in &amp; SSO</h1>
      <p className="mt-1 text-sm text-muted-foreground">People sign in with e-mail + password (with reset and lockout) or with their Google Workspace account.</p>
      <div className="mt-5 max-w-xl space-y-4">
        <label className="block text-xs font-medium text-slate-600">
          Google Workspace domain
          <div className="mt-1 flex items-center gap-2">
            <span className="text-sm text-slate-500">@</span>
            <input
              value={value}
              disabled={!canEdit}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="4s.digital"
              className="w-64 rounded-md border border-border px-3 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-60"
            />
            {canEdit && domain !== null && domain.trim() !== (data.ssoDomain ?? "") && (
              <button type="button" onClick={() => save.mutate(domain.trim() || null)} disabled={save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                Save
              </button>
            )}
            {save.isError && <span className="text-xs text-red-600">{(save.error as Error).message}</span>}
          </div>
        </label>
        <p className="text-xs text-muted-foreground">
          Anyone who signs in with a verified Google account on this domain joins <strong>this workspace</strong> as a member automatically - no invite needed. Remove someone from Google Workspace and they can no longer sign in. Password sign-ups never auto-join.
        </p>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium">One-time setup (Supabase)</p>
          <p className="mt-0.5">{data.googleProviderHint}</p>
          <p className="mt-0.5">Microsoft 365 can be added the same way later.</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Doc starter kit (row 68)
 * ------------------------------------------------------------------ */
function DocKitSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ["doc-templates"], queryFn: api.getDocTemplates });
  const [openId, setOpenId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["doc-templates"] });
  const create = useMutation({ mutationFn: () => api.createDocTemplate({ title }), onSuccess: (t) => { setTitle(""); setOpenId(t.id); refresh(); } });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateDocTemplate>[1] }) => api.updateDocTemplate(id, body), onSuccess: refresh });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.reorderDocTemplates(ids), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteDocTemplate(id), onSuccess: refresh });
  function swap(i: number, j: number) {
    if (j < 0 || j >= templates.length) return;
    const ids = templates.map((t) => t.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  }
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Doc starter kit</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        These docs are created under every new project (in this order) so each one starts with the same structure. Untick “in kit” to keep a template available on demand only.
      </p>
      <ul className="mt-5 space-y-2">
        {templates.map((t, i) => (
          <li key={t.id} className="rounded-lg border border-border bg-white">
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="flex flex-col text-[10px] leading-none text-slate-400">
                <button type="button" disabled={!canEdit || i === 0} onClick={() => swap(i, i - 1)} className="hover:text-slate-700 disabled:opacity-30">▲</button>
                <button type="button" disabled={!canEdit || i === templates.length - 1} onClick={() => swap(i, i + 1)} className="hover:text-slate-700 disabled:opacity-30">▼</button>
              </div>
              <input defaultValue={t.icon ?? ""} disabled={!canEdit} maxLength={4} onBlur={(e) => e.target.value.trim() !== (t.icon ?? "") && update.mutate({ id: t.id, body: { icon: e.target.value.trim() || null } })} className="w-9 rounded-md border border-border px-1 py-0.5 text-center text-base" title="Icon" />
              <InlineName value={t.title} disabled={!canEdit} onCommit={(v) => update.mutate({ id: t.id, body: { title: v } })} />
              <label className="flex items-center gap-1 text-xs text-slate-600">
                <input type="checkbox" checked={t.inKit} disabled={!canEdit} onChange={(e) => update.mutate({ id: t.id, body: { inKit: e.target.checked } })} className="accent-indigo-600" />
                in kit
              </label>
              <button type="button" onClick={() => setOpenId(openId === t.id ? null : t.id)} className="text-xs text-indigo-600 hover:underline">
                {openId === t.id ? "Hide content" : "Edit content"}
              </button>
              {canEdit && (
                <button type="button" onClick={() => window.confirm(`Delete “${t.title}”?`) && remove.mutate(t.id)} className="ml-auto text-xs text-slate-400 hover:text-red-600">
                  Delete
                </button>
              )}
            </div>
            {openId === t.id && (
              <div className="border-t border-border bg-[#fbfbfa] px-4 py-3">
                <DocEditor docId={`doc-template-${t.id}`} title={t.title} content={t.content} body={t.body} settings={{}} onSave={(patch) => update.mutate({ id: t.id, body: patch })} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
          className="mt-3 flex gap-2"
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New template, e.g. Risk register" className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm outline-none focus:border-indigo-500" />
          <button type="submit" disabled={!title.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            Add template
          </button>
        </form>
      )}
    </div>
  );
}
