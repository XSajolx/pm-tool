import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { relativeTime } from "../components/TaskCollaboration.js";

/** Internal documents — optionally attached to a project. */
export function DocsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [projectFilter, setProjectFilter] = useState("");
  const { data: docs = [], isLoading } = useQuery({
    queryKey: ["documents", projectFilter],
    queryFn: () => api.getDocuments(projectFilter || undefined),
  });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });

  const create = useMutation({
    mutationFn: () => api.createDocument({ title: "Untitled document", projectId: projectFilter || null }),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ["documents"] });
      navigate({ to: "/docs/$docId", params: { docId: doc.id } });
    },
  });

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Docs</h1>
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="ml-2 rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
        >
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button
          onClick={() => create.mutate()}
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
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {docs.map((d) => (
              <Link
                key={d.id}
                to="/docs/$docId"
                params={{ docId: d.id }}
                className="rounded-lg border border-border bg-white p-4 transition hover:border-indigo-300 hover:shadow-sm"
              >
                <p className="truncate text-sm font-semibold text-slate-900">{d.title}</p>
                <p className="mt-1 line-clamp-3 text-xs text-slate-600">{d.excerpt || "Empty document"}</p>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  {d.project ? `${d.project.name} · ` : ""}
                  {d.updatedBy?.name ?? "Someone"} · {relativeTime(d.updatedAt)}
                </p>
              </Link>
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">📄</span>
            <p className="text-sm text-muted-foreground">No documents yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** One document. Title and body save on blur; nothing is lost on navigation. */
export function DocPage() {
  const { docId } = useParams({ from: "/docs/$docId" });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, role } = useAuth();
  const { data: doc } = useQuery({ queryKey: ["document", docId], queryFn: () => api.getDocument(docId) });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (doc) {
      setTitle(doc.title);
      setBody(doc.body);
    }
  }, [doc]);

  const save = useMutation({
    mutationFn: (patch: { title?: string; body?: string; projectId?: string | null }) => api.updateDocument(docId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["document", docId] });
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

  if (!doc) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  const canDelete = doc.createdBy?.id === user?.id || role === "owner" || role === "admin";

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/docs" className="text-sm text-muted-foreground hover:text-slate-700">Docs</Link>
        <span className="text-muted-foreground">/</span>
        <span className="truncate text-sm font-semibold text-slate-800">{doc.title}</span>
        <select
          value={doc.projectId ?? ""}
          onChange={(e) => save.mutate({ projectId: e.target.value || null })}
          className="ml-2 rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
        >
          <option value="">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="ml-auto text-xs text-muted-foreground">
          {save.isPending ? "Saving…" : `Edited ${relativeTime(doc.updatedAt)} by ${doc.updatedBy?.name ?? "someone"}`}
        </span>
        {canDelete && (
          <button onClick={() => remove.mutate()} className="text-xs text-slate-400 hover:text-red-500">Delete</button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== doc.title && save.mutate({ title: title.trim() })}
            className="w-full bg-transparent text-3xl font-semibold tracking-tight text-slate-900 outline-none placeholder:text-slate-300"
            placeholder="Untitled"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => body !== doc.body && save.mutate({ body })}
            placeholder="Start writing…"
            className="mt-4 min-h-[60vh] w-full resize-none bg-transparent font-sans text-[15px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-300"
          />
        </div>
      </div>
    </div>
  );
}
