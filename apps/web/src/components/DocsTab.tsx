import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DocLinkEntity } from "../lib/api.js";
import { relativeTime } from "./TaskCollaboration.js";
import { cn } from "../lib/utils.js";

/**
 * Row 61: the docs attached to a project, task, client or deal. Attach an
 * existing doc, or start a new one that is linked (and, for projects, filed
 * under the project) from the first keystroke.
 */
export function DocsTab({ entityType, entityId, projectId, compact }: { entityType: DocLinkEntity; entityId: string; projectId?: string | null; compact?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [attaching, setAttaching] = useState(false);
  const [pick, setPick] = useState("");
  const key = ["documents", "linked", entityType, entityId];
  const { data: docs = [], isLoading } = useQuery({ queryKey: key, queryFn: () => api.getDocuments({ entityType, entityId }) });
  const { data: all = [] } = useQuery({ queryKey: ["documents", "", ""], queryFn: () => api.getDocuments(), enabled: attaching });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["documents"] });
    qc.invalidateQueries({ queryKey: ["document"] });
  };
  const attach = useMutation({
    mutationFn: (docId: string) => api.addDocLink(docId, { entityType, entityId }),
    onSuccess: () => {
      setPick("");
      setAttaching(false);
      refresh();
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const doc = await api.createDocument({ title: "Untitled document", projectId: entityType === "project" ? entityId : (projectId ?? null) });
      if (entityType !== "project") await api.addDocLink(doc.id, { entityType, entityId });
      return doc;
    },
    onSuccess: (doc) => {
      refresh();
      navigate({ to: "/docs/$docId", params: { docId: doc.id } });
    },
  });
  const linked = new Set(docs.map((d) => d.id));
  const candidates = all.filter((d) => !linked.has(d.id));

  return (
    <div className={cn(compact ? "space-y-1.5" : "space-y-2")}>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : docs.length ? (
        <ul className={cn(compact ? "space-y-1" : "overflow-hidden rounded-lg border border-border bg-white")}>
          {docs.map((d) => (
            <li key={d.id}>
              <Link
                to="/docs/$docId"
                params={{ docId: d.id }}
                className={cn("flex items-center gap-2 hover:bg-[#fbfbfa]", compact ? "rounded-md border border-border bg-white px-2 py-1 text-xs" : "border-b border-border px-4 py-2.5 text-sm last:border-b-0")}
              >
                <span className={compact ? "text-sm" : "text-lg leading-none"}>{d.icon || "📄"}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-800">{d.title}</span>
                  {!compact && <span className="block truncate text-xs text-muted-foreground">{d.excerpt || "Empty document"}</span>}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {d.project && entityType !== "project" ? `${d.project.name} · ` : ""}
                  {relativeTime(d.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className={cn("text-muted-foreground", compact ? "text-xs" : "rounded-lg border border-dashed border-border py-6 text-center text-sm")}>No docs attached yet.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {attaching ? (
          <>
            <select value={pick} onChange={(e) => setPick(e.target.value)} className="max-w-[260px] rounded-md border border-border bg-white px-2 py-1 text-xs">
              <option value="">Choose a doc…</option>
              {candidates.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.icon ? `${d.icon} ` : ""}
                  {d.title}
                  {d.project ? ` (${d.project.name})` : ""}
                </option>
              ))}
            </select>
            <button type="button" disabled={!pick || attach.isPending} onClick={() => attach.mutate(pick)} className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">
              Attach
            </button>
            <button type="button" onClick={() => setAttaching(false)} className="px-1 text-xs text-slate-500 hover:text-slate-800">
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setAttaching(true)} className="rounded-md border border-dashed border-border px-2 py-1 text-xs text-slate-600 hover:bg-muted">
              + Attach existing doc
            </button>
            <button type="button" onClick={() => create.mutate()} disabled={create.isPending} className="rounded-md border border-border px-2 py-1 text-xs text-slate-600 hover:bg-muted disabled:opacity-50">
              {create.isPending ? "Creating…" : "New doc"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
