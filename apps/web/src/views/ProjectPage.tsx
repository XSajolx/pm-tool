import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ProjectStatus } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtDuration, fmtMoney, fmtShortDate } from "../lib/format.js";
import { PROJECT_STATUS } from "./ProjectsPage.js";
import { NotFound } from "../components/NotFound.js";
import { cn } from "../lib/utils.js";

/** One project: headline numbers, its lists, who has logged time, recent entries. */
export function ProjectPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const qc = useQueryClient();
  const { role } = useAuth();
  const canManage = role === "owner" || role === "admin";

  const { data: project, isError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  const { data: summary } = useQuery({
    queryKey: ["project-time", projectId],
    queryFn: () => api.getProjectTimeSummary(projectId),
  });
  const { data: entries = [] } = useQuery({
    queryKey: ["time-entries", "project", projectId],
    queryFn: () => api.getTimeEntries({ projectId }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["project", projectId] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const setStatus = useMutation({
    mutationFn: (status: ProjectStatus) => api.updateProject(projectId, { status }),
    onSuccess: refresh,
  });
  const startTimer = useMutation({
    mutationFn: () => api.startTimer({ projectId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["timer"] }),
  });

  if (isError) return <NotFound what="project" />;
  if (!project) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  const { stats } = project;
  const loggedHours = stats.loggedSeconds / 3600;
  const budgetPct = project.budgetHours ? Math.round((loggedHours / project.budgetHours) * 100) : null;
  const status = PROJECT_STATUS[project.status];

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/projects" className="text-sm text-muted-foreground hover:text-slate-700">
          Projects
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="h-3 w-3 rounded-full" style={{ background: project.color }} />
        <h1 className="text-sm font-semibold text-slate-800">{project.name}</h1>
        {project.clientName && (
          <span className="text-xs text-muted-foreground">for {project.clientName}</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {canManage ? (
            <select
              value={project.status}
              onChange={(e) => setStatus.mutate(e.target.value as ProjectStatus)}
              className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", status.cls)}
            >
              {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS[s].label}
                </option>
              ))}
            </select>
          ) : (
            <span className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", status.cls)}>
              {status.label}
            </span>
          )}
          <button
            onClick={() => startTimer.mutate()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700"
          >
            ▶ Start timer
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {/* Headline numbers */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Tasks done" value={`${stats.tasksDone} / ${stats.tasksTotal}`} />
          <Stat
            label="Time logged"
            value={fmtDuration(stats.loggedSeconds)}
            hint={project.budgetHours != null ? `of ${project.budgetHours}h budget` : undefined}
            bar={budgetPct ?? undefined}
            warn={budgetPct != null && budgetPct > 100}
          />
          <Stat
            label="Billable"
            value={
              summary?.billableAmount != null
                ? fmtMoney(summary.billableAmount, project.currency)
                : fmtDuration(stats.billableSeconds)
            }
            hint={
              project.budgetAmount != null
                ? `of ${fmtMoney(project.budgetAmount, project.currency)}`
                : project.hourlyRate != null
                  ? `${fmtMoney(project.hourlyRate, project.currency)}/h`
                  : "no rate set"
            }
          />
          <Stat
            label="Timeline"
            value={
              project.startDate || project.endDate
                ? `${project.startDate ? fmtShortDate(project.startDate) : "…"} → ${project.endDate ? fmtShortDate(project.endDate) : "…"}`
                : "Not set"
            }
          />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Lists */}
          <section className="rounded-lg border border-border bg-white">
            <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Lists
            </h2>
            <ul className="p-2">
              {project.space?.lists.length ? (
                project.space.lists.map((l) => (
                  <li key={l.id}>
                    <Link
                      to="/l/$listId"
                      params={{ listId: l.id }}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-muted"
                    >
                      <svg className="h-3.5 w-3.5 text-slate-400" viewBox="0 0 24 24" fill="none">
                        <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="2" />
                      </svg>
                      {l.name}
                    </Link>
                  </li>
                ))
              ) : (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">No lists.</li>
              )}
            </ul>
          </section>

          {/* Time by person */}
          <section className="rounded-lg border border-border bg-white">
            <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Time by person
            </h2>
            <ul className="p-2">
              {summary?.byUser.length ? (
                summary.byUser.map((u) => (
                  <li key={u.userId} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm">
                    <span className="text-slate-700">{u.name}</span>
                    <span className="tabular-nums text-slate-600">{fmtDuration(u.seconds)}</span>
                  </li>
                ))
              ) : (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">No time logged yet.</li>
              )}
            </ul>
          </section>

          {/* Recent entries */}
          <section className="rounded-lg border border-border bg-white">
            <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent time
            </h2>
            <ul className="p-2">
              {entries.length ? (
                entries.slice(0, 8).map((e) => (
                  <li key={e.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate text-slate-700">
                      {e.description || e.task?.title || "Untitled"}
                      <span className="ml-1.5 text-xs text-muted-foreground">{e.user?.name}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-600">
                      {e.running ? "running" : fmtDuration(e.durationSeconds)}
                    </span>
                  </li>
                ))
              ) : (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">Nothing yet.</li>
              )}
            </ul>
          </section>
        </div>

        {project.description && (
          <section className="mt-6 rounded-lg border border-border bg-white p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              About
            </h2>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{project.description}</p>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  bar,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  bar?: number;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums text-slate-900", warn && "text-red-600")}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      {bar != null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn("h-full rounded-full", warn ? "bg-red-500" : "bg-emerald-500")}
            style={{ width: `${Math.min(100, bar)}%` }}
          />
        </div>
      )}
    </div>
  );
}
