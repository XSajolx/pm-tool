import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Doc, type DocSettings, type DocSummary } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useEscape } from "../lib/useEscape.js";
import { relativeTime } from "../components/TaskCollaboration.js";
import { NotFound } from "../components/NotFound.js";
import { DocEditor } from "../components/doc/DocEditor.js";

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */
const COVERS: { id: string; label: string; css: string }[] = [
  { id: "indigo", label: "Indigo", css: "linear-gradient(135deg,#6366f1,#a855f7)" },
  { id: "ocean", label: "Ocean", css: "linear-gradient(135deg,#0ea5e9,#22d3ee)" },
  { id: "forest", label: "Forest", css: "linear-gradient(135deg,#16a34a,#84cc16)" },
  { id: "sunset", label: "Sunset", css: "linear-gradient(135deg,#f97316,#ec4899)" },
  { id: "slate", label: "Slate", css: "linear-gradient(135deg,#334155,#64748b)" },
  { id: "sand", label: "Sand", css: "linear-gradient(135deg,#f59e0b,#fde68a)" },
];
const coverCss = (id: string | null) => COVERS.find((c) => c.id === id)?.css ?? null;

const QUICK_ICONS = ["📄", "📝", "📋", "📌", "🎯", "🚀", "💡", "🧭", "📊", "🗂️", "🧪", "🛠️", "📣", "🤝", "🔒", "⭐"];

function DocIcon({ icon, className = "" }: { icon: string | null; className?: string }) {
  return <span className={`inline-block ${className}`}>{icon || "📄"}</span>;
}

/** Tree of docs from a flat list, using parentId. Orphans (parent archived/filtered) float to the top. */
function buildTree(docs: DocSummary[]) {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const children = new Map<string | null, DocSummary[]>();
  for (const d of docs) {
    const key = d.parentId && byId.has(d.parentId) ? d.parentId : null;
    children.set(key, [...(children.get(key) ?? []), d]);
  }
  const sortByTitle = (list: DocSummary[]) => [...list].sort((a, b) => a.title.localeCompare(b.title));
  return { roots: sortByTitle(children.get(null) ?? []), childrenOf: (id: string) => sortByTitle(children.get(id) ?? []) };
}

/** Small "⋯" popover menu. */
function ActionMenu({ items, label = "More actions" }: { items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="rounded-md px-2 py-1 text-sm leading-none text-slate-500 hover:bg-muted hover:text-slate-800"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-border bg-white py-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              disabled={it.disabled}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                it.onClick();
              }}
              className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-40 ${it.danger ? "text-red-600" : "text-slate-700"}`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Docs index: page tree + cards + search
 * ------------------------------------------------------------------ */
export function DocsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [projectFilter, setProjectFilter] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ["documents", projectFilter, debounced],
    queryFn: () => api.getDocuments({ projectId: projectFilter || undefined, q: debounced || undefined }),
  });
  const { data: allDocs = [] } = useQuery({ queryKey: ["documents", "", ""], queryFn: () => api.getDocuments() });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });
  const tree = useMemo(() => buildTree(allDocs), [allDocs]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["documents"] });
  const create = useMutation({
    mutationFn: (parentId?: string) =>
      api.createDocument({ title: "Untitled document", projectId: projectFilter || null, parentId: parentId ?? null }),
    onSuccess: (doc) => {
      invalidate();
      navigate({ to: "/docs/$docId", params: { docId: doc.id } });
    },
  });
  const duplicate = useMutation({ mutationFn: (id: string) => api.duplicateDocument(id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteDocument(id), onSuccess: invalidate });

  const searching = Boolean(debounced);

  return (
    <div className="flex h-screen flex-1 overflow-hidden">
      {/* Page tree */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-white md:flex">
        <div className="flex items-center justify-between px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pages</p>
          <button
            type="button"
            title="New doc"
            onClick={() => create.mutate(undefined)}
            className="rounded px-1.5 text-base leading-none text-slate-500 hover:bg-muted hover:text-slate-800"
          >
            +
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {tree.roots.length ? (
            tree.roots.map((d) => <TreeNode key={d.id} doc={d} childrenOf={tree.childrenOf} depth={0} />)
          ) : (
            <p className="px-2 text-xs text-muted-foreground">No pages yet.</p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-6 py-3">
          <h1 className="text-sm font-semibold text-slate-800">Docs</h1>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search docs…"
            className="ml-2 w-56 rounded-md border border-border bg-white px-2.5 py-1 text-xs text-slate-700 outline-none focus:border-indigo-400"
          />
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => create.mutate(undefined)}
            disabled={create.isPending}
            className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            New doc
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : docs.length ? (
            <>
              {searching && (
                <p className="mb-3 text-xs text-muted-foreground">
                  {docs.length} result{docs.length === 1 ? "" : "s"} for “{debounced}”
                </p>
              )}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {docs.map((d) => (
                  <Link
                    key={d.id}
                    to="/docs/$docId"
                    params={{ docId: d.id }}
                    className="group relative overflow-hidden rounded-lg border border-border bg-white transition hover:border-indigo-300 hover:shadow-sm"
                  >
                    <div className="h-2" style={{ background: coverCss(d.cover) ?? "transparent" }} />
                    <div className="p-4">
                      <div className="flex items-start gap-2">
                        <DocIcon icon={d.icon} className="text-lg leading-none" />
                        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{d.title}</p>
                        <div className="opacity-0 transition group-hover:opacity-100">
                          <ActionMenu
                            items={[
                              { label: "Duplicate", onClick: () => duplicate.mutate(d.id) },
                              { label: "Delete", danger: true, onClick: () => remove.mutate(d.id) },
                            ]}
                          />
                        </div>
                      </div>
                      <p className="mt-1 line-clamp-3 text-xs text-slate-600">{d.excerpt || "Empty document"}</p>
                      <p className="mt-3 text-[11px] text-muted-foreground">
                        {d.project ? `${d.project.name} · ` : ""}
                        {d.updatedBy?.name ?? "Someone"} · {relativeTime(d.updatedAt)}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span className="text-2xl">📄</span>
              <p className="text-sm text-muted-foreground">{searching ? "Nothing matches that search." : "No documents yet."}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TreeNode({ doc, childrenOf, depth }: { doc: DocSummary; childrenOf: (id: string) => DocSummary[]; depth: number }) {
  const kids = childrenOf(doc.id);
  const [open, setOpen] = useState(depth < 1);
  return (
    <div>
      <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((o) => !o)}
          className={`h-5 w-5 shrink-0 rounded text-[10px] text-slate-400 hover:bg-muted ${kids.length ? "" : "invisible"}`}
        >
          {open ? "▾" : "▸"}
        </button>
        <Link
          to="/docs/$docId"
          params={{ docId: doc.id }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-slate-700 hover:bg-muted [&.active]:bg-indigo-50 [&.active]:text-indigo-700"
        >
          <DocIcon icon={doc.icon} className="text-sm leading-none" />
          <span className="truncate">{doc.title}</span>
        </Link>
      </div>
      {open && kids.map((k) => <TreeNode key={k.id} doc={k} childrenOf={childrenOf} depth={depth + 1} />)}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One document: cover, icon, title, block editor, side panel
 * ------------------------------------------------------------------ */
export function DocPage() {
  const { docId } = useParams({ from: "/docs/$docId" });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, role } = useAuth();
  const { data: doc, isError } = useQuery({ queryKey: ["document", docId], queryFn: () => api.getDocument(docId) });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });
  const { data: allDocs = [] } = useQuery({ queryKey: ["documents", "", ""], queryFn: () => api.getDocuments() });

  const [title, setTitle] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (doc) setTitle(doc.title);
  }, [doc?.id, doc?.title]);
  useEscape(() => setPanelOpen(false));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["document", docId] });
    qc.invalidateQueries({ queryKey: ["documents"] });
  };
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateDocument>[1]) => api.updateDocument(docId, patch),
    onSuccess: (updated) => {
      // Content saves are frequent; avoid refetching the editor's own doc (it would
      // reset the editor). Patch the cache instead and refresh the list only.
      qc.setQueryData(["document", docId], updated);
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDocument(docId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["documents"] });
      navigate({ to: "/docs" });
    },
  });
  const duplicate = useMutation({
    mutationFn: () => api.duplicateDocument(docId),
    onSuccess: (copy) => {
      invalidate();
      navigate({ to: "/docs/$docId", params: { docId: copy.id } });
    },
  });
  const addSubpage = useMutation({
    mutationFn: () => api.createDocument({ title: "Untitled page", parentId: docId, projectId: doc?.projectId ?? null }),
    onSuccess: (child) => {
      invalidate();
      navigate({ to: "/docs/$docId", params: { docId: child.id } });
    },
  });

  if (isError) return <NotFound what="document" />;
  if (!doc) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  const canDelete = doc.createdBy?.id === user?.id || role === "owner" || role === "admin";
  const settings = doc.settings ?? {};
  const cover = coverCss(doc.cover);
  const wide = settings.width === "wide";

  const commitTitle = () => {
    const t = title.trim();
    if (t && t !== doc.title) save.mutate({ title: t });
    else if (!t) setTitle(doc.title);
  };

  return (
    <div className="flex h-screen flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-6 py-3">
          <Link to="/docs" className="text-sm text-muted-foreground hover:text-slate-700">
            Docs
          </Link>
          {doc.parent && (
            <>
              <span className="text-muted-foreground">/</span>
              <Link
                to="/docs/$docId"
                params={{ docId: doc.parent.id }}
                className="max-w-[160px] truncate text-sm text-muted-foreground hover:text-slate-700"
              >
                {doc.parent.title}
              </Link>
            </>
          )}
          <span className="text-muted-foreground">/</span>
          <span className="truncate text-sm font-semibold text-slate-800">{doc.title}</span>
          <select
            value={doc.projectId ?? ""}
            onChange={(e) => save.mutate({ projectId: e.target.value || null })}
            className="ml-2 rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-muted-foreground">
            {save.isPending || dirty ? "Saving…" : `Edited ${relativeTime(doc.updatedAt)} by ${doc.updatedBy?.name ?? "someone"}`}
          </span>
          <button
            type="button"
            onClick={() => setPanelOpen((o) => !o)}
            className={`rounded-md border px-2.5 py-1 text-xs transition ${panelOpen ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border text-slate-600 hover:bg-muted"}`}
          >
            Options
          </button>
          <ActionMenu
            items={[
              { label: "Rename", onClick: () => titleRef.current?.select() },
              { label: "Add subpage", onClick: () => addSubpage.mutate() },
              { label: "Duplicate", onClick: () => duplicate.mutate() },
              { label: "Delete", danger: true, disabled: !canDelete, onClick: () => remove.mutate() },
            ]}
          />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {cover && <div className="h-36 w-full" style={{ background: cover }} />}
          <div className={`mx-auto px-8 pb-24 ${wide ? "max-w-6xl" : "max-w-3xl"} ${cover ? "-mt-8" : "pt-8"}`}>
            {(doc.icon || cover) && (
              <button
                type="button"
                title="Change icon"
                onClick={() => setPanelOpen(true)}
                className={`mb-2 rounded-lg text-5xl leading-none ${cover ? "bg-white/90 p-1 shadow-sm" : ""}`}
              >
                {doc.icon || "📄"}
              </button>
            )}
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="w-full bg-transparent text-3xl font-semibold tracking-tight text-slate-900 outline-none placeholder:text-slate-300"
              placeholder="Untitled"
            />
            <div className="mt-4">
              <DocEditor
                docId={doc.id}
                content={doc.content}
                body={doc.body}
                settings={settings}
                onDirtyChange={setDirty}
                onSave={(patch) => save.mutate(patch)}
              />
            </div>

            {doc.children.length > 0 && (
              <div className="mt-10 border-t border-border pt-4">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Subpages</p>
                <div className="flex flex-col gap-1">
                  {doc.children.map((c) => (
                    <Link
                      key={c.id}
                      to="/docs/$docId"
                      params={{ docId: c.id }}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-muted"
                    >
                      <DocIcon icon={c.icon} />
                      <span className="truncate">{c.title}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">{relativeTime(c.updatedAt)}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {panelOpen && (
        <DocSidePanel
          doc={doc}
          allDocs={allDocs}
          projects={projects}
          canDelete={canDelete}
          onClose={() => setPanelOpen(false)}
          onPatch={(patch) => save.mutate(patch)}
          onAddSubpage={() => addSubpage.mutate()}
          onDuplicate={() => duplicate.mutate()}
          onDelete={() => remove.mutate()}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Side panel: appearance, icon, cover, organisation, subpages, info
 * ------------------------------------------------------------------ */
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs transition ${value === o.value ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-muted"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border px-4 py-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function DocSidePanel({
  doc,
  allDocs,
  projects,
  canDelete,
  onClose,
  onPatch,
  onAddSubpage,
  onDuplicate,
  onDelete,
}: {
  doc: Doc;
  allDocs: DocSummary[];
  projects: { id: string; name: string }[];
  canDelete: boolean;
  onClose: () => void;
  onPatch: (patch: Parameters<typeof api.updateDocument>[1]) => void;
  onAddSubpage: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const settings: DocSettings = doc.settings ?? {};
  const [iconInput, setIconInput] = useState(doc.icon ?? "");
  useEffect(() => setIconInput(doc.icon ?? ""), [doc.icon]);
  // A doc can't be moved under itself or its own subpages.
  const descendants = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const d of allDocs) if (d.parentId) kids.set(d.parentId, [...(kids.get(d.parentId) ?? []), d.id]);
    const out = new Set<string>([doc.id]);
    const stack = [doc.id];
    while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) if (!out.has(k)) { out.add(k); stack.push(k); }
    return out;
  }, [allDocs, doc.id]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-white">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-semibold text-slate-800">Doc options</p>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-slate-500 hover:bg-muted" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Font">
          <Segmented
            value={settings.font ?? "sans"}
            onChange={(font) => onPatch({ settings: { font } })}
            options={[
              { value: "sans", label: "Sans" },
              { value: "serif", label: "Serif" },
              { value: "mono", label: "Mono" },
            ]}
          />
        </Section>
        <Section title="Text size">
          <Segmented
            value={settings.fontSize ?? "md"}
            onChange={(fontSize) => onPatch({ settings: { fontSize } })}
            options={[
              { value: "sm", label: "Small" },
              { value: "md", label: "Normal" },
              { value: "lg", label: "Large" },
            ]}
          />
        </Section>
        <Section title="Page width">
          <Segmented
            value={settings.width ?? "narrow"}
            onChange={(width) => onPatch({ settings: { width } })}
            options={[
              { value: "narrow", label: "Narrow" },
              { value: "wide", label: "Wide" },
            ]}
          />
        </Section>
        <Section title="Icon">
          <div className="flex flex-wrap gap-1">
            {QUICK_ICONS.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => onPatch({ icon: i })}
                className={`h-8 w-8 rounded-md text-lg hover:bg-muted ${doc.icon === i ? "bg-indigo-50 ring-1 ring-indigo-300" : ""}`}
              >
                {i}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={iconInput}
              onChange={(e) => setIconInput(e.target.value)}
              onBlur={() => onPatch({ icon: iconInput.trim() || null })}
              placeholder="Any emoji…"
              maxLength={8}
              className="w-28 rounded-md border border-border px-2 py-1 text-sm outline-none focus:border-indigo-400"
            />
            {doc.icon && (
              <button type="button" onClick={() => onPatch({ icon: null })} className="text-xs text-slate-500 hover:text-slate-800">
                Remove
              </button>
            )}
          </div>
        </Section>
        <Section title="Cover">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onPatch({ cover: null })}
              className={`h-8 w-12 rounded-md border border-dashed border-border text-[10px] text-slate-500 ${!doc.cover ? "ring-2 ring-indigo-300" : ""}`}
            >
              None
            </button>
            {COVERS.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.label}
                onClick={() => onPatch({ cover: c.id })}
                className={`h-8 w-12 rounded-md ${doc.cover === c.id ? "ring-2 ring-indigo-400 ring-offset-1" : ""}`}
                style={{ background: c.css }}
              />
            ))}
          </div>
        </Section>
        <Section title="Organise">
          <label className="mb-1 block text-xs text-slate-600">Project</label>
          <select
            value={doc.projectId ?? ""}
            onChange={(e) => onPatch({ projectId: e.target.value || null })}
            className="mb-3 w-full rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label className="mb-1 block text-xs text-slate-600">Parent page</label>
          <select
            value={doc.parentId ?? ""}
            onChange={(e) => onPatch({ parentId: e.target.value || null })}
            className="w-full rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
          >
            <option value="">Top level</option>
            {allDocs
              .filter((d) => !descendants.has(d.id))
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.icon ? `${d.icon} ` : ""}
                  {d.title}
                </option>
              ))}
          </select>
        </Section>
        <Section title="Subpages">
          {doc.children.length ? (
            <div className="mb-2 flex flex-col gap-0.5">
              {doc.children.map((c) => (
                <Link key={c.id} to="/docs/$docId" params={{ docId: c.id }} className="truncate rounded px-1.5 py-1 text-sm text-slate-700 hover:bg-muted">
                  <DocIcon icon={c.icon} className="mr-1.5" />
                  {c.title}
                </Link>
              ))}
            </div>
          ) : (
            <p className="mb-2 text-xs text-muted-foreground">No subpages.</p>
          )}
          <button type="button" onClick={onAddSubpage} className="text-xs font-medium text-indigo-600 hover:text-indigo-800">
            + Add subpage
          </button>
        </Section>
        <Section title="Info">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-600">
            <dt className="text-muted-foreground">Created</dt>
            <dd>
              {relativeTime(doc.createdAt)} by {doc.createdBy?.name ?? "someone"}
            </dd>
            <dt className="text-muted-foreground">Edited</dt>
            <dd>
              {relativeTime(doc.updatedAt)} by {doc.updatedBy?.name ?? "someone"}
            </dd>
            <dt className="text-muted-foreground">Words</dt>
            <dd>{doc.body.trim() ? doc.body.trim().split(/\s+/).length : 0}</dd>
          </dl>
        </Section>
        <Section title="Actions">
          <div className="flex flex-col items-start gap-1.5">
            <button type="button" onClick={onDuplicate} className="text-xs text-slate-700 hover:text-slate-900">
              Duplicate doc
            </button>
            <button
              type="button"
              disabled={!canDelete}
              onClick={onDelete}
              className="text-xs text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Delete doc
            </button>
          </div>
        </Section>
      </div>
    </aside>
  );
}
