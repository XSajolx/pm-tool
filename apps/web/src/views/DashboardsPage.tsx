import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { fmtDuration, fmtMoney, fmtShortDate } from "../lib/format.js";
import { cn } from "../lib/utils.js";

/**
 * A view over everything else. Nothing here has its own storage — every tile is
 * derived from endpoints that already exist, so it can never disagree with the
 * page it links to.
 */
export function DashboardsPage() {
  const weekStart = useMemo(() => {
    const d = new Date();
    const day = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString();
  }, []);

  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });
  const { data: board = [] } = useQuery({ queryKey: ["deal-board"], queryFn: api.getDealBoard });
  const { data: myTasks = [] } = useQuery({ queryKey: ["my-tasks"], queryFn: () => api.getMyTasks() });
  const { data: week = [] } = useQuery({ queryKey: ["time-entries", "week", weekStart], queryFn: () => api.getTimeEntries({ from: weekStart }) });
  const { data: meetings = [] } = useQuery({ queryKey: ["meetings", true], queryFn: () => api.getMeetings({ mine: true }) });
  const { data: estimates = [] } = useQuery({ queryKey: ["estimates"], queryFn: () => api.getEstimates() });

  const active = projects.filter((p) => p.status === "active");
  const overBudget = active.filter((p) => p.budgetHours != null && p.stats.loggedSeconds / 3600 > p.budgetHours);
  const openCols = board.filter((c) => c.stage.kind === "open");
  const pipeline = openCols.reduce((a, c) => a + c.value, 0);
  const weighted = openCols.reduce((a, c) => a + c.weighted, 0);
  const wonThisMonth = board.filter((c) => c.stage.kind === "won").flatMap((c) => c.deals).filter((d) => d.closedAt && new Date(d.closedAt).getMonth() === new Date().getMonth()) ?? [];
  const weekSeconds = week.reduce((a, e) => a + e.durationSeconds, 0);
  const overdue = myTasks.filter((t) => t.dueDate && new Date(t.dueDate) < new Date());
  const awaiting = estimates.filter((e) => e.status === "sent");

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Dashboard</h1>
        <span className="text-xs text-muted-foreground">Live across projects, pipeline, time and your work</span>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Tile label="Active projects" value={String(active.length)} hint={overBudget.length ? `${overBudget.length} over budget` : "all within budget"} warn={overBudget.length > 0} to="/projects" />
          <Tile label="Open pipeline" value={fmtMoney(pipeline)} hint={`${fmtMoney(weighted)} weighted`} to="/crm/deals" />
          <Tile label="Logged this week" value={fmtDuration(weekSeconds)} hint={`${week.length} entries`} to="/time" />
          <Tile label="My open tasks" value={String(myTasks.length)} hint={overdue.length ? `${overdue.length} overdue` : "nothing overdue"} warn={overdue.length > 0} to="/inbox" />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Panel title="Pipeline by stage" to="/crm/deals">
            {board.length ? (
              <ul className="space-y-2">
                {board.map((c) => {
                  const max = Math.max(1, ...board.map((x) => x.value));
                  return (
                    <li key={c.stage.id} className="text-sm">
                      <div className="flex justify-between text-xs text-slate-600">
                        <span>{c.stage.name} <span className="text-muted-foreground">({c.count})</span></span>
                        <span className="tabular-nums">{fmtMoney(c.value)}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full" style={{ width: `${(c.value / max) * 100}%`, background: c.stage.color }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty text="No deals yet." />
            )}
            {wonThisMonth.length > 0 && (
              <p className="mt-3 text-xs text-emerald-700">
                Won this month: {fmtMoney(wonThisMonth.reduce((a, d) => a + d.value, 0))} across {wonThisMonth.length}
              </p>
            )}
          </Panel>

          <Panel title="Projects — hours vs budget" to="/projects">
            {active.length ? (
              <ul className="space-y-2.5">
                {active.slice(0, 6).map((p) => {
                  const hours = p.stats.loggedSeconds / 3600;
                  const pct = p.budgetHours ? Math.min(100, Math.round((hours / p.budgetHours) * 100)) : null;
                  const over = p.budgetHours != null && hours > p.budgetHours;
                  return (
                    <li key={p.id} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />
                        <Link to="/projects/$projectId" params={{ projectId: p.id }} className="min-w-0 flex-1 truncate text-slate-800 hover:text-indigo-700">{p.name}</Link>
                        <span className={cn("text-xs tabular-nums", over ? "font-medium text-red-600" : "text-muted-foreground")}>
                          {fmtDuration(p.stats.loggedSeconds)}{p.budgetHours != null ? ` / ${p.budgetHours}h` : ""}
                        </span>
                      </div>
                      {pct != null && (
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div className={cn("h-full rounded-full", over ? "bg-red-500" : "bg-emerald-500")} style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty text="No active projects." />
            )}
          </Panel>

          <Panel title="Coming up" to="/crm/meetings">
            {meetings.length ? (
              <ul className="space-y-2">
                {meetings.slice(0, 6).map((m) => (
                  <li key={m.id} className="flex items-center gap-3 text-sm">
                    <span className="w-12 shrink-0 text-xs text-muted-foreground">{fmtShortDate(m.startsAt)}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-800">{m.title}</span>
                    <span className="text-xs text-muted-foreground">{new Date(m.startsAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="Nothing on your calendar." />
            )}
            {awaiting.length > 0 && (
              <p className="mt-3 text-xs text-sky-700">
                {awaiting.length} estimate{awaiting.length > 1 ? "s" : ""} awaiting a reply · {fmtMoney(awaiting.reduce((a, e) => a + e.total, 0))}
              </p>
            )}
          </Panel>
        </div>

        {overdue.length > 0 && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">Overdue — assigned to you</p>
            <ul className="mt-2 space-y-1">
              {overdue.slice(0, 5).map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm text-red-900">
                  <span className="text-xs text-red-600">{t.reference}</span>
                  <Link to="/t/$taskId" params={{ taskId: t.id }} className="truncate hover:underline">{t.title}</Link>
                  <span className="ml-auto text-xs">{fmtShortDate(t.dueDate!)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, hint, warn, to }: { label: string; value: string; hint?: string; warn?: boolean; to: string }) {
  return (
    <Link to={to} className="rounded-lg border border-border bg-white p-4 transition hover:border-indigo-300">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums text-slate-900", warn && "text-red-600")}>{value}</p>
      {hint && <p className={cn("mt-0.5 text-xs", warn ? "text-red-600" : "text-muted-foreground")}>{hint}</p>}
    </Link>
  );
}

function Panel({ title, to, children }: { title: string; to: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-white">
      <div className="flex items-center border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <Link to={to} className="ml-auto text-xs font-medium text-indigo-600 hover:text-indigo-700">Open</Link>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}
