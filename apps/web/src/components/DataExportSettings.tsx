import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

/** Row 117: the whole workspace, or one project, as a ZIP of JSON + CSVs. */
export function DataExportSettings() {
  const { data: projects = [] } = useQuery({ queryKey: ["projects", true], queryFn: () => api.getProjects(true) });
  const [projectId, setProjectId] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const run = useMutation({ mutationFn: (id?: string) => api.downloadExport(id), onSuccess: (name) => setDone(name) });
  const field = "rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500";
  return (
    <div className="max-w-2xl" data-testid="data-export">
      <h1 className="text-lg font-semibold text-slate-900">Data export</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Everything you own, in formats you can read anywhere: one <code className="rounded bg-slate-100 px-1">export.json</code> with every record (ids included) plus a CSV per table - projects, tasks, comments, docs, milestones, stages, time entries, companies, contacts, deals, members. Nothing is removed from the workspace.
      </p>
      <div className="mt-5 rounded-lg border border-border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Whole workspace</h2>
        <p className="text-xs text-muted-foreground">Active records across every project and the CRM.</p>
        <button type="button" disabled={run.isPending} onClick={() => run.mutate(undefined)} className="mt-3 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {run.isPending ? "Preparing…" : "Download workspace (.zip)"}
        </button>
      </div>
      <div className="mt-4 rounded-lg border border-border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">One project</h2>
        <p className="text-xs text-muted-foreground">Its tasks, comments, docs, milestones, stages, time entries and the client's company and contacts.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={`${field} min-w-[16rem]`} aria-label="Project">
            <option value="">Choose a project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status === "archived" ? " (archived)" : ""}</option>)}
          </select>
          <button type="button" disabled={!projectId || run.isPending} onClick={() => run.mutate(projectId)} className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50">
            Download project (.zip)
          </button>
        </div>
      </div>
      {done && <p className="mt-3 text-xs text-green-700">Downloaded {done}. Each export is recorded in the audit log.</p>}
      {run.isError && <p className="mt-3 text-xs text-red-600">{(run.error as Error).message}</p>}
    </div>
  );
}
