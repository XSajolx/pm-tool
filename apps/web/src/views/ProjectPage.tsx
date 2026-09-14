import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Milestone, type Project, type ProjectStatus, type Stage } from "../lib/api.js";
import { Avatar } from "../components/ui.js";
import { useAuth } from "../lib/auth.js";
import { fmtDuration, fmtMoney, fmtShortDate } from "../lib/format.js";
import { PROJECT_STATUS } from "./ProjectsPage.js";
import { NotFound } from "../components/NotFound.js";
import { ProjectTeam } from "../components/ProjectTeam.js";
import { DocsTab } from "../components/DocsTab.js";
import { MuteButton } from "../components/MuteButton.js";
import { FollowButton } from "../components/FollowButton.js";
import { MilestoneTimeline } from "../components/MilestoneTimeline.js";
import { ProjectActivityFeed } from "../components/ProjectActivityFeed.js";
import { cn } from "../lib/utils.js";

/** One project: headline numbers, its lists, who has logged time, recent entries. */
export function ProjectPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const qc = useQueryClient();
  const { role, user } = useAuth();
  const isAdmin = role === "owner" || role === "admin";

  const { data: project, isError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  // Row 85: the project's lead (or anyone with the lead role on it) manages it like an admin.
  const { data: team = [] } = useQuery({ queryKey: ["project-members", project?.id ?? ""], queryFn: () => api.getProjectMembers(project!.id), enabled: Boolean(project?.id) });
  const leadCanManage = Boolean(user && (project?.leadId === user.id || team.some((m) => m.id === user.id && m.role === "lead")));
  const canManage = isAdmin || leadCanManage;
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
        <FollowButton entityType="project" entityId={project.id} compact />
        <MuteButton entityType="project" entityId={project.id} compact />
        {project.company ? (
          <Link
            to="/crm/companies/$companyId"
            params={{ companyId: project.company.id }}
            className="text-xs text-muted-foreground hover:text-indigo-700"
          >
            for {project.company.name}
          </Link>
        ) : (
          project.clientName && <span className="text-xs text-muted-foreground">for {project.clientName}</span>
        )}
        {project.lead && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-0.5 pr-2 text-[11px] text-slate-700" title="Project lead">
            <Avatar user={{ id: project.lead.id, name: project.lead.name, avatarUrl: project.lead.avatarUrl, email: "", role: "member" }} size={16} />
            {project.lead.name}
          </span>
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
        {/* Row 99: quick links to the project's chat, docs and client */}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          {stats.channelId ? (
            <Link to="/chat/$channelId" params={{ channelId: stats.channelId }} className="rounded-full border border-border bg-white px-2.5 py-1 text-slate-700 hover:border-indigo-300 hover:text-indigo-700">
              💬 Project chat
            </Link>
          ) : (
            <span className="rounded-full border border-border bg-white px-2.5 py-1 text-muted-foreground" title="No chat channel yet - add a team member to create one">💬 No chat yet</span>
          )}
          <a href="#project-docs" className="rounded-full border border-border bg-white px-2.5 py-1 text-slate-700 hover:border-indigo-300 hover:text-indigo-700">
            📄 Docs
          </a>
          {project.company && (
            <Link to="/crm/companies/$companyId" params={{ companyId: project.company.id }} className="rounded-full border border-border bg-white px-2.5 py-1 text-slate-700 hover:border-indigo-300 hover:text-indigo-700">
              🏢 {project.company.name}
            </Link>
          )}
          {stats.tasksOverdue > 0 && (
            <span className="ml-auto rounded-full bg-red-50 px-2.5 py-1 font-medium text-red-700">
              {stats.tasksOverdue} overdue task{stats.tasksOverdue === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <Stat
            label="Tasks"
            value={`${stats.tasksDone} / ${stats.tasksTotal}`}
            hint={stats.tasksTotal ? `${stats.tasksOpen} open${stats.tasksOverdue ? ` · ${stats.tasksOverdue} overdue` : ""}` : "no tasks yet"}
            bar={stats.tasksTotal ? Math.round((stats.tasksDone / stats.tasksTotal) * 100) : undefined}
            warn={stats.tasksOverdue > 0}
          />
          <Stat label="Hours this week" value={fmtDuration(stats.weekSeconds)} hint="since Monday" />
          <Stat
            label="Next milestone"
            value={stats.nextMilestone ? stats.nextMilestone.name : "None"}
            hint={
              stats.nextMilestone
                ? stats.nextMilestone.targetDate
                  ? `${stats.nextMilestone.overdue ? "was due" : "due"} ${fmtShortDate(stats.nextMilestone.targetDate)}`
                  : "no target date"
                : "all reached"
            }
            warn={Boolean(stats.nextMilestone?.overdue)}
          />
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

        <ProjectDetails project={project} canManage={canManage} onSaved={refresh} />
        <ProjectTeam projectId={project.id} canManage={canManage} />
        <ProjectStages projectId={project.id} canManage={canManage} />
        <ProjectMilestones projectId={project.id} canManage={canManage} startDate={project.startDate} endDate={project.endDate} />
        {canManage && <ApplyTemplate projectId={project.id} />}

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

        <section className="mt-6 rounded-lg border border-border bg-white">
          <h2 id="project-docs" className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Docs</h2>
          <div className="p-4">
            <DocsTab entityType="project" entityId={project.id} />
          </div>
        </section>

        {/* Row 102 */}
        <ProjectActivityFeed projectId={project.id} />

        <InboundEmailCard projectId={project.id} canManage={canManage} />

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
      <p className={cn("mt-1 truncate text-xl font-semibold tabular-nums text-slate-900", warn && "text-red-600")} title={value}>
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

/** Editable record: client company, lead, start and target dates. */
function ProjectDetails({ project, canManage, onSaved }: { project: Project; canManage: boolean; onSaved: () => void }) {
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateProject>[1]) => api.updateProject(project.id, patch),
    onSuccess: onSaved,
  });
  const toIso = (v: string) => (v ? new Date(v + "T00:00:00Z").toISOString() : null);
  const sel = "w-full rounded-md border border-border bg-white px-2 py-1 text-sm text-slate-800 disabled:bg-muted/40";
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 rounded-lg border border-border bg-white p-4 md:grid-cols-4">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Client</span>
        <select
          value={project.companyId ?? ""}
          disabled={!canManage}
          onChange={(e) => save.mutate({ companyId: e.target.value || null })}
          className={sel}
        >
          <option value="">{project.clientName && !project.companyId ? `${project.clientName} (not in CRM)` : "— none —"}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Project lead</span>
        <select
          value={project.leadId ?? ""}
          disabled={!canManage}
          onChange={(e) => save.mutate({ leadId: e.target.value || null })}
          className={sel}
        >
          <option value="">— unassigned —</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Start date</span>
        <input
          type="date"
          disabled={!canManage}
          value={project.startDate ? project.startDate.slice(0, 10) : ""}
          onChange={(e) => save.mutate({ startDate: toIso(e.target.value) })}
          className={sel}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Target date</span>
        <input
          type="date"
          disabled={!canManage}
          value={project.endDate ? project.endDate.slice(0, 10) : ""}
          onChange={(e) => save.mutate({ endDate: toIso(e.target.value) })}
          className={sel}
        />
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Stages strip: Discovery > Design > Build > QA > Launch with per-stage
 * task progress and start / complete / reopen controls.
 * ------------------------------------------------------------------ */
const STAGE_STATUS: Record<Stage["status"], { label: string; cls: string; bar: string }> = {
  not_started: { label: "Not started", cls: "bg-slate-100 text-slate-600", bar: "bg-slate-300" },
  active: { label: "In progress", cls: "bg-blue-50 text-blue-700", bar: "bg-indigo-500" },
  completed: { label: "Completed", cls: "bg-green-50 text-green-700", bar: "bg-green-500" },
};

function ProjectStages({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const { data: stages = [] } = useQuery({ queryKey: ["stages", projectId], queryFn: () => api.getStages(projectId) });
  const { data: templates = [] } = useQuery({ queryKey: ["stage-templates"], queryFn: api.getStageTemplates });
  const [newName, setNewName] = useState("");
  const [reopening, setReopening] = useState<Stage | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["stages"] });
    qc.invalidateQueries({ queryKey: ["project", projectId] });
  };
  const create = useMutation({
    mutationFn: () => api.createStage(projectId, newName.trim()),
    onSuccess: () => {
      setNewName("");
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.updateStage>[1]) => api.updateStage(id, body),
    onSuccess: () => {
      setReopening(null);
      setNote("");
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.reorderStages(projectId, ids),
    onSuccess: (rows) => qc.setQueryData(["stages", projectId], rows),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteStage(id), onSuccess: refresh });
  const apply = useMutation({ mutationFn: (templateId: string) => api.applyStageTemplate(projectId, templateId), onSuccess: refresh });

  const move = (i: number, dir: -1 | 1) => {
    const ids = stages.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <div className="mt-6 rounded-lg border border-border bg-white p-4">
      <div className="mb-3 flex items-center gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Stages</p>
        <span className="text-[11px] text-muted-foreground">
          {stages.filter((s) => s.status === "completed").length}/{stages.length} complete
        </span>
        {canManage && !stages.length && templates.length > 0 && (
          <select
            value=""
            onChange={(e) => e.target.value && apply.mutate(e.target.value)}
            className="ml-auto rounded-md border border-border bg-white px-2 py-1 text-xs"
          >
            <option value="">Apply a stage template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.stages.join(" › ")})
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      {stages.length ? (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {stages.map((st, i) => {
            const meta = STAGE_STATUS[st.status];
            const pct = st.progress.total ? Math.round((st.progress.done / st.progress.total) * 100) : 0;
            return (
              <div key={st.id} className="flex w-52 shrink-0 flex-col gap-2 rounded-lg border border-border p-3">
                <div className="flex items-start gap-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">{i + 1}</span>
                  <StageName stage={st} canEdit={canManage} onRename={(name) => update.mutate({ id: st.id, name })} />
                  {canManage && (
                    <div className="ml-auto flex flex-col text-[9px] leading-none text-slate-400">
                      <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="hover:text-slate-700 disabled:opacity-30">◀</button>
                      <button type="button" disabled={i === stages.length - 1} onClick={() => move(i, 1)} className="hover:text-slate-700 disabled:opacity-30">▶</button>
                    </div>
                  )}
                </div>
                <span className={cn("w-fit rounded-full px-2 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.label}</span>
                {/* Row 105: progress is a judgement, set by hand */}
                <StageProgress stage={st} canEdit={canManage} bar={meta.bar} />
                <p className="text-[10px] text-muted-foreground" title="Task counts are context only - they never drive the percent">
                  Tasks {st.progress.done}/{st.progress.total}{st.progress.total ? ` (${pct}% ticked)` : ""}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {st.startedAt ? `Started ${fmtShortDate(st.startedAt)}` : "Not started"}
                  {st.completedAt ? ` · Done ${fmtShortDate(st.completedAt)}` : ""}
                </p>
                {canManage && (
                  <div className="mt-auto flex flex-wrap gap-1">
                    {st.status === "not_started" && (
                      <button type="button" onClick={() => update.mutate({ id: st.id, status: "active" })} className="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-700">
                        Start
                      </button>
                    )}
                    {st.status === "active" && (
                      <button type="button" onClick={() => update.mutate({ id: st.id, status: "completed" })} className="rounded-md bg-green-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-green-700">
                        Complete
                      </button>
                    )}
                    {st.status === "completed" && (
                      <button type="button" onClick={() => setReopening(st)} className="rounded-md border border-border px-2 py-1 text-[11px] text-slate-700 hover:bg-muted">
                        Reopen
                      </button>
                    )}
                    <button type="button" onClick={() => remove.mutate(st.id)} className="ml-auto text-[11px] text-slate-400 hover:text-red-500">
                      Remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No stages yet. Add one below or apply a template.</p>
      )}

      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) create.mutate();
          }}
          className="mt-3 flex items-center gap-2"
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Add a stage (e.g. QA)…"
            className="w-64 rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:border-indigo-400"
          />
          <button type="submit" disabled={!newName.trim() || create.isPending} className="rounded-md border border-border px-3 py-1 text-xs text-slate-700 hover:bg-muted disabled:opacity-50">
            Add stage
          </button>
        </form>
      )}

      {reopening && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={() => setReopening(null)}>
          <div className="w-96 rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-slate-900">Reopen “{reopening.name}”</h2>
            <p className="mt-1 text-xs text-muted-foreground">A short note goes on the stage timeline so the team knows why.</p>
            <textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Client requested a second design round"
              className="mt-3 w-full rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
              rows={3}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setReopening(null)} className="rounded-md px-3 py-1.5 text-xs text-slate-600 hover:bg-muted">Cancel</button>
              <button
                type="button"
                disabled={!note.trim()}
                onClick={() => update.mutate({ id: reopening.id, status: "active", note: note.trim() })}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Reopen stage
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Row 105: percent complete typed by the PM, stamped with their name and time.
 * Lowering it asks for a note; the History toggle shows every change.
 */
function StageProgress({ stage, canEdit, bar }: { stage: Stage; canEdit: boolean; bar: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [pct, setPct] = useState(stage.progressPct);
  const [note, setNote] = useState("");
  const [history, setHistory] = useState(false);
  const save = useMutation({
    mutationFn: () => api.setStageProgress(stage.id, { pct, note: note.trim() || undefined }),
    onSuccess: () => {
      setEditing(false);
      setNote("");
      qc.invalidateQueries({ queryKey: ["stages"] });
      qc.invalidateQueries({ queryKey: ["stage-progress", stage.id] });
      qc.invalidateQueries({ queryKey: ["project-activity"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const { data: events = [] } = useQuery({ queryKey: ["stage-progress", stage.id], queryFn: () => api.getStageProgressHistory(stage.id), enabled: history });
  const lowering = pct < stage.progressPct;
  const err = save.error ? String((save.error as Error).message) : null;

  return (
    <div data-testid="stage-progress">
      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Progress</span>
        {canEdit && !editing ? (
          <button type="button" onClick={() => { setPct(stage.progressPct); setEditing(true); }} className="rounded px-1 font-semibold tabular-nums text-slate-700 hover:bg-slate-100 hover:text-indigo-700" title="Set percent complete">
            {stage.progressPct}% ✎
          </button>
        ) : (
          <span className="font-semibold tabular-nums text-slate-700">{stage.progressPct}%</span>
        )}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${stage.progressPct}%` }} />
      </div>
      {editing ? (
        <form
          onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
          className="mt-1.5 space-y-1"
        >
          <div className="flex items-center gap-1">
            <input type="range" min={0} max={100} step={5} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="flex-1 accent-indigo-600" aria-label="Percent complete" />
            <input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="w-12 rounded border border-border px-1 py-0.5 text-right text-[11px] tabular-nums outline-none focus:border-indigo-400" />
            <span className="text-[10px] text-muted-foreground">%</span>
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={lowering ? "Why is it going down? (required)" : "Note (optional)"}
            className={cn("w-full rounded border px-1.5 py-0.5 text-[11px] outline-none focus:border-indigo-400", lowering && !note.trim() ? "border-amber-300 bg-amber-50/40" : "border-border")}
          />
          {err && <p className="text-[10px] text-red-600">{err}</p>}
          <div className="flex gap-1">
            <button type="submit" disabled={save.isPending || (lowering && !note.trim())} className="rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save</button>
            <button type="button" onClick={() => setEditing(false)} className="px-1 text-[11px] text-muted-foreground hover:text-slate-700">Cancel</button>
          </div>
        </form>
      ) : (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {stage.progressSetBy && stage.progressSetAt ? (
            <>
              Set by <span className="text-slate-700">{stage.progressSetBy.name}</span> · {new Date(stage.progressSetAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {stage.progressNote ? <span className="block truncate italic" title={stage.progressNote}>“{stage.progressNote}”</span> : null}
            </>
          ) : (
            "Not set yet"
          )}
          {" "}
          <button type="button" onClick={() => setHistory((h) => !h)} className="text-indigo-700 hover:underline">{history ? "Hide history" : "History"}</button>
        </p>
      )}
      {history && (
        <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto rounded border border-border bg-slate-50 p-1.5 text-[10px] text-slate-600">
          {events.length ? (
            events.map((e) => (
              <li key={e.id}>
                <span className={cn("font-medium tabular-nums", e.toPct < e.fromPct ? "text-red-600" : "text-slate-800")}>{e.fromPct}% → {e.toPct}%</span>
                {" "}by {e.actor?.name ?? "someone"} · {new Date(e.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                {e.note ? <span className="block italic">“{e.note}”</span> : null}
              </li>
            ))
          ) : (
            <li className="text-muted-foreground">No changes yet.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function StageName({ stage, canEdit, onRename }: { stage: Stage; canEdit: boolean; onRename: (name: string) => void }) {
  const [text, setText] = useState(stage.name);
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => {
          setText(stage.name);
          setEditing(true);
        }}
        className="truncate text-left text-sm font-semibold text-slate-900 disabled:cursor-default"
        title={canEdit ? "Rename" : undefined}
      >
        {stage.name}
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (text.trim() && text.trim() !== stage.name) onRename(text.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
      className="w-full rounded border border-indigo-300 px-1 text-sm font-semibold outline-none"
    />
  );
}

/* ------------------------------------------------------------------ *
 * Milestones: target date, linked-task progress, "reached" set by hand,
 * optional client visibility.
 * ------------------------------------------------------------------ */
function ProjectMilestones({ projectId, canManage, startDate, endDate }: { projectId: string; canManage: boolean; startDate?: string | null; endDate?: string | null }) {
  const qc = useQueryClient();
  const { data: milestones = [] } = useQuery({ queryKey: ["milestones", projectId], queryFn: () => api.getMilestones(projectId) });
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["milestones"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const create = useMutation({
    mutationFn: () => api.createMilestone(projectId, { name: name.trim(), targetDate: target ? `${target}T00:00:00.000Z` : null }),
    onSuccess: () => {
      setName("");
      setTarget("");
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.updateMilestone>[1]) => api.updateMilestone(id, body),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteMilestone(id), onSuccess: refresh });
  // Row 75: ask the project lead to sign the milestone off from their inbox.
  const signoff = useMutation({ mutationFn: (id: string) => api.requestMilestoneSignoff(id), onSuccess: refresh });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mt-6 rounded-lg border border-border bg-white p-4">
      <div className="mb-3 flex items-center gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Milestones</p>
        <span className="text-[11px] text-muted-foreground">
          {milestones.filter((m) => m.reachedAt).length}/{milestones.length} reached
        </span>
      </div>
      {/* Row 101: target vs reached on one axis */}
      <MilestoneTimeline milestones={milestones} startDate={startDate} endDate={endDate} />
      {milestones.length ? (
        <ul className="divide-y divide-border">
          {milestones.map((m) => {
            const pct = m.progress.total ? Math.round((m.progress.done / m.progress.total) * 100) : 0;
            const overdue = !m.reachedAt && m.targetDate && m.targetDate.slice(0, 10) < today;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-3 py-2">
                <input
                  type="checkbox"
                  checked={Boolean(m.reachedAt)}
                  disabled={!canManage}
                  title={m.reachedAt ? "Mark as not reached" : "Mark as reached today"}
                  onChange={(e) => update.mutate({ id: m.id, reachedAt: e.target.checked ? new Date().toISOString() : null })}
                  className="h-4 w-4 cursor-pointer accent-green-600"
                />
                <div className="min-w-0 flex-1">
                  <MilestoneName milestone={m} canEdit={canManage} onRename={(v) => update.mutate({ id: m.id, name: v })} />
                  <p className="text-[11px] text-muted-foreground">
                    {m.reachedAt
                      ? `Reached ${fmtShortDate(m.reachedAt)}`
                      : m.targetDate
                        ? `Target ${fmtShortDate(m.targetDate)}`
                        : "No target date"}
                    {overdue ? " · past target" : ""}
                    {" · "}
                    {m.progress.done}/{m.progress.total} tasks done
                  </p>
                </div>
                {!m.reachedAt && m.signoffStatus === "pending" && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800" title="Waiting for the approver to decide in their inbox">
                    Sign-off pending
                  </span>
                )}
                {!m.reachedAt && m.signoffStatus === "rejected" && (
                  <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700" title={m.signoffNote ?? undefined}>
                    Sign-off declined
                  </span>
                )}
                {!m.reachedAt && m.signoffStatus !== "pending" && (
                  <button
                    type="button"
                    onClick={() => signoff.mutate(m.id)}
                    disabled={signoff.isPending}
                    className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-muted disabled:opacity-50"
                    title="Send an Approve / Reject card to the project lead's inbox"
                  >
                    {m.signoffStatus === "rejected" ? "Ask again" : "Request sign-off"}
                  </button>
                )}
                {signoff.isError && <span className="text-[11px] text-red-600">{(signoff.error as Error).message}</span>}
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-100" title={`${pct}% of linked tasks done`}>
                  <div className={cn("h-full rounded-full", m.reachedAt ? "bg-green-500" : "bg-indigo-500")} style={{ width: `${pct}%` }} />
                </div>
                {canManage && (
                  <>
                    <input
                      type="date"
                      value={m.targetDate ? m.targetDate.slice(0, 10) : ""}
                      onChange={(e) => update.mutate({ id: m.id, targetDate: e.target.value ? `${e.target.value}T00:00:00.000Z` : null })}
                      className="rounded-md border border-border px-2 py-0.5 text-xs"
                      title="Target date"
                    />
                    <label className="flex items-center gap-1 text-[11px] text-slate-600" title="Show on the client portal">
                      <input type="checkbox" checked={m.clientVisible} onChange={(e) => update.mutate({ id: m.id, clientVisible: e.target.checked })} className="accent-indigo-600" />
                      Client-visible
                    </label>
                    <button type="button" onClick={() => remove.mutate(m.id)} className="text-[11px] text-slate-400 hover:text-red-500">
                      Remove
                    </button>
                  </>
                )}
                {!canManage && m.clientVisible && <span className="rounded-full bg-indigo-50 px-2 text-[10px] text-indigo-700">Client-visible</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No milestones yet.</p>
      )}
      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Milestone name (e.g. Design sign-off)" className="w-64 rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:border-indigo-400" />
          <input type="date" value={target} onChange={(e) => setTarget(e.target.value)} className="rounded-md border border-border bg-white px-2 py-1 text-sm" title="Target date" />
          <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md border border-border px-3 py-1 text-xs text-slate-700 hover:bg-muted disabled:opacity-50">
            Add milestone
          </button>
        </form>
      )}
    </div>
  );
}

function MilestoneName({ milestone, canEdit, onRename }: { milestone: Milestone; canEdit: boolean; onRename: (v: string) => void }) {
  const [text, setText] = useState(milestone.name);
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button type="button" disabled={!canEdit} onClick={() => { setText(milestone.name); setEditing(true); }} className={cn("block truncate text-left text-sm font-medium disabled:cursor-default", milestone.reachedAt ? "text-slate-500 line-through" : "text-slate-900")} title={canEdit ? "Rename" : undefined}>
        {milestone.name}
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { setEditing(false); if (text.trim() && text.trim() !== milestone.name) onRename(text.trim()); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
      className="w-full rounded border border-indigo-300 px-1 text-sm font-medium outline-none"
    />
  );
}

/* ------------------------------------------------------------------ *
 * Apply a task list template to this project (row 33)
 * ------------------------------------------------------------------ */
function ApplyTemplate({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ["task-templates"], queryFn: api.getTaskTemplates });
  const { data: lists = [] } = useQuery({ queryKey: ["project-lists", projectId], queryFn: () => api.getProjectLists(projectId) });
  const [templateId, setTemplateId] = useState("");
  const [listId, setListId] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const apply = useMutation({
    mutationFn: () => api.applyTaskTemplate(templateId, { projectId, listId: listId || undefined }),
    onSuccess: (res) => {
      setResult(`Added ${res.tasksCreated} tasks, ${res.subtasksCreated} subtasks and ${res.milestonesCreated} milestones.`);
      setTemplateId("");
      qc.invalidateQueries({ queryKey: ["milestones"] });
      qc.invalidateQueries({ queryKey: ["stages"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e: Error) => setResult(e.message),
  });
  if (!templates.length) return null;
  const chosen = templates.find((t) => t.id === templateId);
  return (
    <div className="mt-6 rounded-lg border border-dashed border-border bg-white p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Apply a task list template</p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="rounded-md border border-border bg-white px-2 py-1 text-sm">
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.taskCount} tasks, {t.milestoneCount} milestones)
            </option>
          ))}
        </select>
        <select value={listId} onChange={(e) => setListId(e.target.value)} className="rounded-md border border-border bg-white px-2 py-1 text-sm">
          <option value="">Into: first list</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              Into: {l.name}
            </option>
          ))}
        </select>
        <button type="button" disabled={!templateId || apply.isPending} onClick={() => apply.mutate()} className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
          {apply.isPending ? "Applying…" : "Apply template"}
        </button>
        {chosen?.description && <span className="text-xs text-muted-foreground">{chosen.description}</span>}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Due dates are set relative to the project start date{result ? ` · ${result}` : "."}
      </p>
    </div>
  );
}


/**
 * Row 78: the project's email-in address. Forward a client mail there and it
 * becomes a task (or a comment on the task named in the subject), attachments
 * included. The "test" form fakes an inbound mail until a provider is wired up.
 */
function InboundEmailCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["inbound-email", projectId], queryFn: () => api.getInboundEmail(projectId) });
  const regen = useMutation({ mutationFn: () => api.regenerateInboundEmail(projectId), onSuccess: (next) => qc.setQueryData(["inbound-email", projectId], next) });
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [from, setFrom] = useState("client@example.com");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: () => api.testInboundEmail(projectId, { from, subject, text }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      setSubject("");
      setText("");
    },
  });
  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked - the address is still selectable */
    }
  };
  return (
    <section className="mt-6 rounded-lg border border-border bg-white">
      <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email-in</h2>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted-foreground">
          Forward a client email to this address and it becomes a task in this project - attachments included. Put an existing task reference like <code className="rounded bg-muted px-1">[PM-142]</code> in the subject (or reply in-thread) and it lands as a comment instead.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="select-all rounded-md border border-border bg-[#fbfbfa] px-2.5 py-1 text-xs text-slate-800">{data?.address ?? "…"}</code>
          <button type="button" onClick={copy} className="rounded-md border border-border px-2 py-1 text-xs font-medium text-slate-600 hover:bg-muted">
            {copied ? "Copied ✓" : "Copy"}
          </button>
          {canManage && (
            <button type="button" onClick={() => regen.mutate()} disabled={regen.isPending} className="text-xs text-slate-500 hover:text-red-600 hover:underline disabled:opacity-50" title="Old address stops working">
              Regenerate
            </button>
          )}
          <button type="button" onClick={() => setTesting((t) => !t)} className="ml-auto text-xs text-indigo-600 hover:underline">
            {testing ? "Hide test" : "Send a test email"}
          </button>
        </div>
        {data && !data.configured && (
          <p className="text-[11px] text-amber-700">Inbound mail service not connected yet (set INBOUND_EMAIL_DOMAIN + INBOUND_EMAIL_SECRET and point Postmark / SES at /public/inbound/email). The address works the moment it is.</p>
        )}
        {testing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (subject.trim()) send.mutate();
            }}
            className="grid gap-2 rounded-md border border-border bg-[#fbfbfa] p-3 sm:grid-cols-2"
          >
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From (client@example.com)" className="rounded-md border border-border px-2 py-1 text-xs" />
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject - becomes the task title" className="rounded-md border border-border px-2 py-1 text-xs" required />
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Email body - becomes the description" rows={3} className="rounded-md border border-border px-2 py-1 text-xs sm:col-span-2" />
            <div className="flex items-center gap-2 sm:col-span-2">
              <button type="submit" disabled={send.isPending || !subject.trim()} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                Deliver test email
              </button>
              {send.isSuccess && (
                <Link to="/t/$taskId" params={{ taskId: send.data.taskId }} className="text-xs text-green-700 hover:underline">
                  ✓ Created {send.data.kind === "task" ? "a task" : "a comment"} - open it
                </Link>
              )}
              {send.isError && <span className="text-xs text-red-600">{(send.error as Error).message}</span>}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
