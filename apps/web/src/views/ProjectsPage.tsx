import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Project, type ProjectStatus } from "../lib/api.js";
import { Avatar } from "../components/ui.js";
import { fmtShortDate } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { fmtDuration, fmtMoney } from "../lib/format.js";
import { cn } from "../lib/utils.js";

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-green-50 text-green-700 border-green-200" },
  on_hold: { label: "On hold", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  completed: { label: "Completed", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  archived: { label: "Archived", cls: "bg-slate-100 text-slate-600 border-slate-200" },
};

const COLORS = ["#6366f1", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];

/** Card grid of projects with task progress and hours against budget. */
export function ProjectsPage() {
  const { role } = useAuth();
  const canManage = role === "owner" || role === "admin";
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects", showArchived],
    queryFn: () => api.getProjects(showArchived),
  });

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Projects</h1>
        <label className="ml-2 flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="accent-indigo-600"
          />
          Show archived
        </label>
        {canManage && (
          <button
            onClick={() => setCreating(true)}
            className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700"
          >
            New project
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : projects.length ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">📁</span>
            <p className="text-sm text-muted-foreground">
              {canManage ? "No projects yet. Create the first one." : "No projects yet."}
            </p>
          </div>
        )}
      </div>

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const { tasksTotal, tasksDone, loggedSeconds, billableSeconds } = p.stats;
  const taskPct = tasksTotal ? Math.round((tasksDone / tasksTotal) * 100) : 0;
  const loggedHours = loggedSeconds / 3600;
  const budgetPct = p.budgetHours ? Math.min(100, Math.round((loggedHours / p.budgetHours) * 100)) : null;
  const overBudget = p.budgetHours != null && loggedHours > p.budgetHours;
  const status = PROJECT_STATUS[p.status];

  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: p.id }}
      className="group flex flex-col overflow-hidden rounded-lg border border-border bg-white transition hover:border-indigo-300 hover:shadow-sm"
    >
      <div className="h-1.5" style={{ background: p.color }} />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-700">
              {p.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {p.company?.name ?? p.clientName ?? "No client"}
            </p>
          </div>
          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", status.cls)}>
            {status.label}
          </span>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {p.lead ? (
            <span className="inline-flex items-center gap-1" title={`Lead: ${p.lead.name}`}>
              <Avatar user={{ id: p.lead.id, name: p.lead.name, avatarUrl: p.lead.avatarUrl, email: "", role: "member" }} size={16} />
              {p.lead.name.split(" ")[0]}
            </span>
          ) : (
            <span>No lead</span>
          )}
          <span className="ml-auto tabular-nums">
            {p.startDate ? fmtShortDate(p.startDate) : "…"} → {p.endDate ? fmtShortDate(p.endDate) : "…"}
          </span>
        </div>

        <div>
          <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
            <span>Tasks</span>
            <span className="tabular-nums">
              {tasksDone}/{tasksTotal} · {taskPct}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${taskPct}%` }} />
          </div>
        </div>

        <div>
          <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
            <span>Time</span>
            <span className={cn("tabular-nums", overBudget && "font-medium text-red-600")}>
              {fmtDuration(loggedSeconds)}
              {p.budgetHours != null ? ` / ${p.budgetHours}h` : ""}
            </span>
          </div>
          {budgetPct != null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className={cn("h-full rounded-full", overBudget ? "bg-red-500" : "bg-emerald-500")}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
          )}
        </div>

        {p.hourlyRate != null && (
          <p className="text-[11px] text-muted-foreground">
            Billable {fmtMoney((billableSeconds / 3600) * p.hourlyRate, p.currency)}
            {p.budgetAmount != null ? ` of ${fmtMoney(p.budgetAmount, p.currency)}` : ""}
          </p>
        )}
      </div>
    </Link>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [leadId, setLeadId] = useState("");
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const [color, setColor] = useState(COLORS[0]!);
  const [budgetHours, setBudgetHours] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        clientName: companyId ? undefined : clientName.trim() || undefined,
        companyId: companyId || undefined,
        leadId: leadId || undefined,
        color,
        budgetHours: budgetHours ? Number(budgetHours) : undefined,
        hourlyRate: hourlyRate ? Number(hourlyRate) : undefined,
        startDate: startDate ? new Date(startDate).toISOString() : undefined,
        endDate: endDate ? new Date(endDate).toISOString() : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["spaces"] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form
        onSubmit={submit}
        className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold text-slate-900">New project</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A space with default statuses and a first list is created with it.
        </p>

        <div className="mt-4 space-y-3">
          <Field label="Name">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required className={input} placeholder="Website redesign" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Client (CRM company)">
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={input}>
                <option value="">— none —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Project lead">
              <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className={input}>
                <option value="">— unassigned —</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {!companyId && (
            <Field label="Client name (if not in CRM)">
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} className={input} placeholder="Acme Ltd" />
            </Field>
          )}
          <Field label="Color">
            <div className="flex gap-1.5">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setColor(c)}
                  className={cn("h-6 w-6 rounded-full border-2 transition", color === c ? "border-slate-800" : "border-transparent")}
                  style={{ background: c }}
                />
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Budget (hours)">
              <input type="number" min="0" value={budgetHours} onChange={(e) => setBudgetHours(e.target.value)} className={input} placeholder="120" />
            </Field>
            <Field label="Hourly rate">
              <input type="number" min="0" step="0.01" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} className={input} placeholder="50" />
            </Field>
            <Field label="Start">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={input} />
            </Field>
            <Field label="Target end">
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={input} />
            </Field>
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </>
  );
}

const input =
  "w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
