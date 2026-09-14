import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PortalDoc, PortalProject } from "../lib/api.js";
import { DocReadOnly } from "./doc/DocReadOnly.js";
import { cn } from "../lib/utils.js";

/**
 * Row 118: the client portal page for one project. Pure presentation - the
 * caller supplies the data and a doc loader, so the same view serves the PM
 * preview and the guest link. Nothing here knows about hours or comments.
 */
const STAGE: Record<PortalProject["stages"][number]["status"], { label: string; cls: string; bar: string }> = {
  not_started: { label: "Not started", cls: "bg-slate-100 text-slate-600", bar: "bg-slate-300" },
  active: { label: "In progress", cls: "bg-blue-50 text-blue-700", bar: "bg-indigo-500" },
  completed: { label: "Done", cls: "bg-green-50 text-green-700", bar: "bg-green-500" },
};
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null);

export function PortalProjectView({
  data,
  loadDoc,
  banner,
  approvalSlot,
  onOpenDoc,
}: {
  data: PortalProject;
  loadDoc: (docId: string) => Promise<PortalDoc>;
  banner?: ReactNode;
  /** Row 121: renders approve / request-changes controls for a milestone or doc. */
  approvalSlot?: (kind: "milestone" | "document", id: string) => ReactNode;
  onOpenDoc?: (docId: string) => void;
}) {
  const [docId, setDocId] = useState<string | null>(null);
  const { data: doc, isLoading: docLoading } = useQuery({ queryKey: ["portal-doc", data.project.id, docId], queryFn: () => loadDoc(docId!), enabled: Boolean(docId) });
  const accent = data.organization.brandColor;
  const openTasks = data.tasks.filter((t) => !t.completedAt);
  const doneTasks = data.tasks.filter((t) => t.completedAt);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800" data-testid="portal-view">
      <header className="text-white" style={{ background: accent }}>
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-5">
          {data.organization.brandLogoUrl ? <img src={data.organization.brandLogoUrl} alt="" className="h-9 w-9 rounded bg-white/90 object-contain p-0.5" /> : <span className="flex h-9 w-9 items-center justify-center rounded bg-white/20 text-sm font-bold">{data.organization.name.slice(0, 2).toUpperCase()}</span>}
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide opacity-80">{data.organization.name} · Client portal</p>
            <h1 className="truncate text-xl font-semibold">{data.project.name}</h1>
          </div>
          <span className="ml-auto rounded-full bg-white/20 px-2.5 py-1 text-xs font-medium capitalize">{data.project.status.replace("_", " ")}</span>
        </div>
      </header>
      {banner}
      <main className="mx-auto max-w-4xl space-y-6 px-6 py-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-slate-600">
            {data.project.client && <span><span className="text-slate-400">For</span> {data.project.client}</span>}
            {data.project.lead && <span><span className="text-slate-400">Your contact</span> {data.project.lead}</span>}
            {(data.project.startDate || data.project.endDate) && <span><span className="text-slate-400">Timeline</span> {fmtDate(data.project.startDate) ?? "…"} → {fmtDate(data.project.endDate) ?? "…"}</span>}
          </div>
          {data.project.description && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{data.project.description}</p>}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Where we are</h2>
            <span className="text-xs text-slate-500">{data.stageSummary.completed}/{data.stageSummary.total} stages done{data.stageSummary.current ? ` · now: ${data.stageSummary.current}` : ""}</span>
          </div>
          {data.stages.length ? (
            <ol className="flex gap-2 overflow-x-auto pb-1">
              {data.stages.map((s) => {
                const m = STAGE[s.status];
                return (
                  <li key={s.id} className="min-w-[10rem] flex-1 rounded-lg border border-slate-200 p-3">
                    <p className="text-[10px] font-semibold text-slate-400">{s.index}</p>
                    <p className="truncate text-sm font-medium text-slate-800" title={s.name}>{s.name}</p>
                    <span className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium", m.cls)}>{m.label}</span>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={cn("h-full", m.bar)} style={{ width: `${s.status === "completed" ? 100 : s.progressPct}%` }} /></div>
                    <p className="mt-1 text-[10px] text-slate-500">{s.status === "completed" ? `Done ${fmtDate(s.completedAt) ?? ""}` : `${s.progressPct}% complete`}</p>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm text-slate-500">Stages haven't been set up yet.</p>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Milestones</h2>
          {data.milestones.length ? (
            <ul className="divide-y divide-slate-100">
              {data.milestones.map((m) => {
                const late = !m.reachedAt && m.targetDate && new Date(m.targetDate) < new Date();
                return (
                  <li key={m.id} className="flex flex-wrap items-start gap-3 py-2.5">
                    <span className={cn("mt-1 h-3 w-3 shrink-0 rotate-45 border-2", m.reachedAt ? "border-green-500 bg-green-500" : late ? "border-red-500 bg-white" : "border-slate-400 bg-white")} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800">{m.name}</p>
                      <p className="text-xs text-slate-500">
                        {m.reachedAt ? `Reached ${fmtDate(m.reachedAt)}` : m.targetDate ? `Target ${fmtDate(m.targetDate)}${late ? " · running late" : ""}` : "No date yet"}
                        {m.openTasks ? ` · ${m.openTasks} item${m.openTasks === 1 ? "" : "s"} still open` : ""}
                      </p>
                      {m.description && <p className="mt-1 text-xs text-slate-600">{m.description}</p>}
                      {m.clientDecision && (
                        <p className={cn("mt-1 text-xs", m.clientDecision === "approved" ? "text-green-700" : "text-amber-700")}>
                          {m.clientDecision === "approved" ? "✓ Approved" : "Changes requested"} by {m.clientApprovedBy ?? "you"}{m.clientApprovedAt ? ` on ${fmtDate(m.clientApprovedAt)}` : ""}{m.clientApprovalNote ? ` · “${m.clientApprovalNote}”` : ""}
                        </p>
                      )}
                    </div>
                    {approvalSlot?.("milestone", m.id)}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No milestones have been shared yet.</p>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Work in progress</h2>
          {data.tasks.length ? (
            <>
              <ul className="divide-y divide-slate-100">
                {openTasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.statusColor ?? "#94a3b8" }} />
                    <span className="min-w-0 flex-1 truncate text-slate-800">{t.title}</span>
                    {t.status && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{t.status}</span>}
                    {t.dueDate && <span className="text-xs text-slate-500">{fmtDate(t.dueDate)}</span>}
                  </li>
                ))}
              </ul>
              {doneTasks.length > 0 && <p className="mt-2 text-xs text-slate-500">{doneTasks.length} item{doneTasks.length === 1 ? "" : "s"} completed: {doneTasks.slice(0, 5).map((t) => t.title).join(", ")}{doneTasks.length > 5 ? "…" : ""}</p>}
            </>
          ) : (
            <p className="text-sm text-slate-500">Nothing shared here yet.</p>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Documents</h2>
          {data.docs.length ? (
            <ul className="divide-y divide-slate-100">
              {data.docs.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <button type="button" onClick={() => { setDocId(docId === d.id ? null : d.id); onOpenDoc?.(d.id); }} className="min-w-0 flex-1 truncate text-left font-medium text-slate-800 hover:underline">
                    {d.icon ? `${d.icon} ` : "📄 "}{d.title}
                  </button>
                  {d.reviewStatus === "approved" && <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] text-green-700">Approved internally</span>}
                  {d.clientDecision && <span className={cn("rounded-full px-2 py-0.5 text-[11px]", d.clientDecision === "approved" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700")}>{d.clientDecision === "approved" ? "✓ You approved" : "Changes requested"}</span>}
                  <span className="text-xs text-slate-500">Updated {fmtDate(d.updatedAt)}</span>
                  {approvalSlot?.("document", d.id)}
                  {docId === d.id && (
                    <div className="basis-full rounded-lg border border-slate-200 bg-slate-50 p-4">
                      {docLoading || !doc ? <p className="text-xs text-slate-500">Loading…</p> : <DocReadOnly content={doc.content} body={doc.body} settings={doc.settings} />}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No documents have been shared yet.</p>
          )}
        </section>
        <p className="pb-6 text-center text-[11px] text-slate-400">{data.organization.brandFooter ?? data.organization.name} · Updated {new Date(data.generatedAt).toLocaleString()}</p>
      </main>
    </div>
  );
}
