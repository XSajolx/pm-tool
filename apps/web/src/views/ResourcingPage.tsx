import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ResourcingBoard, type ResourcingCell } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtHours, fmtShortDate } from "../lib/format.js";
import { cn } from "../lib/utils.js";

const WEEK_MS = 7 * 86_400_000;
const NONE = "";

/**
 * People × weeks, 12+ weeks ahead (row 147). Each cell is planned hours —
 * per project stage — against the hours the person actually has that week
 * (capacity minus holidays and approved leave), with logged hours beside it.
 * Heatmap mode (row 149) colours by plan vs available; a project view lays
 * planned beside logged per person and stage. Admins click a cell to plan.
 */
export function ResourcingPage() {
  const qc = useQueryClient();
  const { role } = useAuth();
  const isAdmin = role === "owner" || role === "admin";
  const [from, setFrom] = useState(() => new Date());
  const [weeks, setWeeks] = useState(12);
  const [mode, setMode] = useState<"plan" | "heat">("plan");
  const [projectId, setProjectId] = useState("");
  const [editing, setEditing] = useState<{ userId: string; week: string } | null>(null);

  const fromIso = from.toISOString();
  const { data: board, isLoading } = useQuery({ queryKey: ["resourcing", fromIso, weeks], queryFn: () => api.getResourcing(fromIso, weeks) });
  const { data: leave = [] } = useQuery({ queryKey: ["leave-calendar", fromIso, weeks], queryFn: () => api.getLeaveCalendar(fromIso, new Date(from.getTime() + weeks * WEEK_MS).toISOString()) });
  const leaveFor = (userId: string, weekStart: string) => {
    const ws = new Date(weekStart).getTime();
    const we = ws + WEEK_MS;
    return leave.filter((l) => l.userId === userId && new Date(l.startDate).getTime() < we && new Date(l.endDate).getTime() + 86_400_000 > ws);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ["resourcing"] });
  const setCapacity = useMutation({ mutationFn: ({ userId, hours }: { userId: string; hours: number }) => api.setCapacity(userId, hours), onSuccess: refresh });
  const overCount = board?.members.reduce((a, m) => a + m.cells.filter((c) => c.over).length, 0) ?? 0;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden" data-testid="resourcing">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Resourcing</h1>
        <span className="text-xs text-muted-foreground">Planned hours per stage vs hours available, {weeks} weeks</span>
        {overCount > 0 && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700" data-testid="over-count">{overCount} over-allocated week{overCount === 1 ? "" : "s"}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="rounded-md border border-border bg-white px-2 py-1 text-xs" title="Planned vs logged for one project (row 149)">
            <option value="">All projects</option>
            {board?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="mx-1 inline-flex overflow-hidden rounded-md border border-border text-xs">
            <button onClick={() => setMode("plan")} className={cn("px-2.5 py-1", mode === "plan" ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-muted")}>Plan</button>
            <button onClick={() => setMode("heat")} className={cn("px-2.5 py-1", mode === "heat" ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-muted")}>Heatmap</button>
          </span>
          <span className="inline-flex overflow-hidden rounded-md border border-border text-xs">
            {[12, 16, 26].map((n) => <button key={n} onClick={() => setWeeks(n)} className={cn("px-2 py-1", weeks === n ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-muted")}>{n}w</button>)}
          </span>
          <NavBtn onClick={() => setFrom(new Date(from.getTime() - WEEK_MS * 4))}>‹ 4w</NavBtn>
          <button onClick={() => setFrom(new Date())} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted">Today</button>
          <NavBtn onClick={() => setFrom(new Date(from.getTime() + WEEK_MS * 4))}>4w ›</NavBtn>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading || !board ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : projectId ? (
          <PlanVsLogged projectId={projectId} from={fromIso} weeks={weeks} />
        ) : (
          <>
            <div className="inline-block min-w-full overflow-hidden rounded-lg border border-border bg-white">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-[#fbfbfa] text-xs text-muted-foreground">
                    <th className="w-52 border-b border-r border-border px-3 py-2 text-left font-medium">Person</th>
                    <th className="w-20 border-b border-r border-border px-2 py-2 text-center font-medium">Capacity</th>
                    {board.weeks.map((w) => (
                      <th key={w} className="min-w-[84px] border-b border-border px-2 py-2 text-center font-medium">{fmtShortDate(w)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {board.members.map((m) => (
                    <tr key={m.userId}>
                      <td className="border-b border-r border-border px-3 py-2">
                        <p className="font-medium text-slate-800">{m.name}</p>
                        <p className="text-[11px] capitalize text-muted-foreground">{m.role}</p>
                      </td>
                      <td className="border-b border-r border-border px-2 py-2 text-center">
                        {isAdmin ? <CapacityInput value={m.capacity} onCommit={(h) => setCapacity.mutate({ userId: m.userId, hours: h })} /> : <span className="tabular-nums text-slate-700">{m.capacity}h</span>}
                      </td>
                      {m.cells.map((c) => (
                        <td key={c.weekStart} className="relative border-b border-border p-1">
                          {mode === "plan" ? (
                            <Cell cell={c} clickable={isAdmin} onClick={() => setEditing({ userId: m.userId, week: c.weekStart })} projects={board.projects} />
                          ) : (
                            <HeatCell cell={c} clickable={isAdmin} onClick={() => setEditing({ userId: m.userId, week: c.weekStart })} />
                          )}
                          {leaveFor(m.userId, c.weekStart).map((l) => (
                            <span key={l.id} className={`pointer-events-none absolute left-1.5 top-1.5 rounded px-1 text-[10px] font-medium ${l.status === "approved" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`} title={`${l.name}: ${l.kind} ${new Date(l.startDate).toLocaleDateString()} → ${new Date(l.endDate).toLocaleDateString()} (${l.status})`}>
                              🏖 {l.days}d{l.status === "pending" ? "?" : ""}
                            </span>
                          ))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Legend mode={mode} />
          </>
        )}
      </div>

      {editing && board && <AllocationDialog board={board} userId={editing.userId} week={editing.week} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function utilizationTone(u: number, over: boolean) {
  if (over) return "bg-red-50 text-red-800 border-red-200";
  if (u === 0) return "bg-white text-slate-400 border-border";
  if (u < 0.8) return "bg-emerald-50 text-emerald-800 border-emerald-200";
  return "bg-amber-50 text-amber-800 border-amber-200";
}

function Cell({ cell, clickable, onClick, projects }: { cell: ResourcingCell; clickable: boolean; onClick: () => void; projects: ResourcingBoard["projects"] }) {
  const pct = Math.round(cell.utilization * 100);
  const lines = Object.entries(cell.byProject).map(([pid, h]) => `${projects.find((p) => p.id === pid)?.name ?? "?"}: ${fmtHours(h)}`);
  return (
    <button
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className={cn("flex h-14 w-full flex-col items-center justify-center rounded-md border text-xs transition", utilizationTone(cell.utilization, cell.over), clickable && "hover:ring-2 hover:ring-indigo-300")}
      title={lines.length ? `${pct}% of ${cell.available}h available · ${fmtHours(cell.logged)} logged\n${lines.join("\n")}` : `Not planned · ${cell.available}h available`}
      data-over={cell.over || undefined}
    >
      <span className="text-sm font-semibold tabular-nums">
        {cell.allocated ? fmtHours(cell.allocated) : "–"}
        <span className="text-[10px] font-normal opacity-70"> / {cell.available}h</span>
      </span>
      <span className="text-[10px] tabular-nums opacity-70">{cell.logged ? `${fmtHours(cell.logged)} logged` : cell.allocated ? `${pct}%` : ""}</span>
    </button>
  );
}

/** Row 149: intensity = planned ÷ available; the small bar underneath is logged ÷ available. */
function HeatCell({ cell, clickable, onClick }: { cell: ResourcingCell; clickable: boolean; onClick: () => void }) {
  const u = Math.min(1.5, cell.utilization);
  const alpha = u === 0 ? 0 : 0.15 + Math.min(1, u) * 0.6;
  const bg = cell.over ? `rgba(220, 38, 38, ${alpha})` : `rgba(79, 70, 229, ${alpha})`;
  const loggedPct = cell.available ? Math.min(100, Math.round((cell.logged / cell.available) * 100)) : 0;
  return (
    <button onClick={clickable ? onClick : undefined} disabled={!clickable} className={cn("flex h-14 w-full flex-col items-center justify-center rounded-md border border-border text-xs", clickable && "hover:ring-2 hover:ring-indigo-300")} style={{ background: bg }} title={`${fmtHours(cell.allocated)} planned of ${cell.available}h · ${fmtHours(cell.logged)} logged`}>
      <span className={cn("text-sm font-semibold tabular-nums", alpha > 0.45 ? "text-white" : "text-slate-800")}>{cell.allocated ? `${Math.round(cell.utilization * 100)}%` : "·"}</span>
      <span className="mt-1 h-1 w-12 overflow-hidden rounded bg-black/10"><span className="block h-full bg-emerald-500" style={{ width: `${loggedPct}%` }} /></span>
    </button>
  );
}

function CapacityInput({ value, onCommit }: { value: number; onCommit: (h: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min="0"
      max="168"
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && Number(draft) !== value) onCommit(Number(draft));
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="w-14 rounded-md border border-transparent bg-transparent text-center text-sm tabular-nums text-slate-700 hover:border-border focus:border-indigo-500 focus:outline-none"
      title="Weekly capacity (hours)"
    />
  );
}

/** Row 147: split the week across projects and their stages. */
function AllocationDialog({ board, userId, week, onClose, onSaved }: { board: ResourcingBoard; userId: string; week: string; onClose: () => void; onSaved: () => void }) {
  const member = board.members.find((m) => m.userId === userId)!;
  const cell = member.cells.find((c) => c.weekStart === week)!;
  const keyOf = (pid: string, sid: string) => `${pid}|${sid}`;
  const [hours, setHours] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of board.projects) {
      const st = cell.byStage[p.id] ?? {};
      for (const s of [...p.stages.map((x) => x.id), NONE]) init[keyOf(p.id, s)] = st[s] ? String(st[s]) : "";
    }
    return init;
  });
  const [openProject, setOpenProject] = useState<string | null>(() => board.projects.find((p) => Object.keys(cell.byStage[p.id] ?? {}).length)?.id ?? board.projects[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      for (const p of board.projects) {
        for (const s of [...p.stages.map((x) => x.id), NONE]) {
          const next = Number(hours[keyOf(p.id, s)] || 0);
          const prev = cell.byStage[p.id]?.[s] ?? 0;
          if (Math.abs(next - prev) > 0.001) await api.setAllocation({ userId, projectId: p.id, stageId: s || null, weekStart: week, hours: next });
        }
      }
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  const totalFor = (pid: string) => Object.entries(hours).filter(([k]) => k.startsWith(pid + "|")).reduce((a, [, v]) => a + Number(v || 0), 0);
  const total = board.projects.reduce((a, p) => a + totalFor(p.id), 0);
  const over = total > cell.available + 0.05;
  const inputCls = "w-20 rounded-md border border-border px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-indigo-500";

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[520px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-white shadow-xl" data-testid="allocation-dialog">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{member.name}</h2>
          <p className="text-xs text-muted-foreground">Week of {fmtShortDate(week)} · {cell.available}h available{cell.available !== member.capacity ? ` (capacity ${member.capacity}h, less holidays / leave)` : ""}{cell.logged ? ` · ${fmtHours(cell.logged)} logged so far` : ""}</p>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-3">
          {board.projects.length ? (
            board.projects.map((p) => {
              const t = totalFor(p.id);
              const isOpen = openProject === p.id;
              const loggedHere = cell.loggedByProject[p.id] ?? 0;
              return (
                <div key={p.id} className={cn("rounded-md border", isOpen ? "border-indigo-200" : "border-border")}>
                  <button type="button" onClick={() => setOpenProject(isOpen ? null : p.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{p.name}</span>
                    {loggedHere > 0 && <span className="text-[10px] text-muted-foreground">{fmtHours(loggedHere)} logged</span>}
                    <span className={cn("text-sm tabular-nums", t > 0 ? "font-semibold text-slate-900" : "text-muted-foreground")}>{t ? fmtHours(t) : "–"}</span>
                    <span className="text-xs text-muted-foreground">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && (
                    <div className="space-y-1.5 border-t border-border bg-[#fbfbfa] px-3 py-2">
                      {p.stages.map((s) => (
                        <label key={s.id} className="flex items-center gap-3 text-xs">
                          <span className={cn("min-w-0 flex-1 truncate", s.status === "completed" ? "text-muted-foreground line-through" : "text-slate-700")}>{s.name}{s.status === "active" ? <span className="ml-1 text-[10px] text-indigo-700">active</span> : null}</span>
                          {(cell.loggedByStage[p.id]?.[s.id] ?? 0) > 0 && <span className="text-[10px] text-muted-foreground">{fmtHours(cell.loggedByStage[p.id]![s.id]!)} logged</span>}
                          <input type="number" min="0" step="0.5" value={hours[keyOf(p.id, s.id)] ?? ""} onChange={(e) => setHours((h) => ({ ...h, [keyOf(p.id, s.id)]: e.target.value }))} placeholder="0" className={inputCls} />
                          <span className="w-3 text-muted-foreground">h</span>
                        </label>
                      ))}
                      <label className="flex items-center gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.stages.length ? "Not tied to a stage" : "Whole project"}</span>
                        <input type="number" min="0" step="0.5" value={hours[keyOf(p.id, NONE)] ?? ""} onChange={(e) => setHours((h) => ({ ...h, [keyOf(p.id, NONE)]: e.target.value }))} placeholder="0" className={inputCls} />
                        <span className="w-3 text-muted-foreground">h</span>
                      </label>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">No active projects to plan against.</p>
          )}
        </div>
        <div className="border-t border-border px-5 py-3">
          <div className={cn("flex items-center justify-between rounded-md px-3 py-2 text-sm", over ? "bg-red-50 text-red-700" : "bg-muted text-slate-700")}>
            <span>Planned</span>
            <span className="font-semibold tabular-nums">{fmtHours(total)} / {cell.available}h{over ? " — over what they have" : ""}</span>
          </div>
          {over && <p className="mt-1 text-[11px] text-red-700">Saving this sends the project managers one over-allocation alert for this week (row 148).</p>}
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50">{save.isPending ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Row 149: one project — planned beside logged, per person and stage, week by week. */
function PlanVsLogged({ projectId, from, weeks }: { projectId: string; from: string; weeks: number }) {
  const { data } = useQuery({ queryKey: ["plan-vs-logged", projectId, from, weeks], queryFn: () => api.getPlanVsLogged(projectId, from, weeks) });
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const drift = (planned: number, logged: number) => (planned === 0 ? (logged > 0 ? "text-amber-700" : "text-muted-foreground") : logged > planned * 1.1 ? "text-red-700" : logged < planned * 0.5 ? "text-amber-700" : "text-emerald-700");
  return (
    <div className="space-y-4" data-testid="plan-vs-logged">
      <div className="flex flex-wrap items-center gap-3">
        <span className="h-3 w-3 rounded-full" style={{ background: data.project.color }} />
        <Link to="/projects/$projectId" params={{ projectId: data.project.id }} className="text-sm font-semibold text-slate-900 hover:underline">{data.project.name}</Link>
        <span className="text-xs text-muted-foreground">planned vs logged, {weeks} weeks from {fmtShortDate(data.weeks[0]!)}</span>
        <span className="ml-auto flex flex-wrap gap-1 text-[11px]">
          {data.byStage.map((s) => (
            <span key={s.id || "none"} className="rounded border border-border bg-white px-2 py-0.5">{s.name}: <b className="tabular-nums">{fmtHours(s.planned)}</b> planned · <b className={cn("tabular-nums", drift(s.planned, s.logged))}>{fmtHours(s.logged)}</b> logged</span>
          ))}
        </span>
      </div>
      <div className="inline-block min-w-full overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-[#fbfbfa] text-muted-foreground">
              <th className="border-b border-r border-border px-3 py-2 text-left font-medium">Person · stage</th>
              <th className="border-b border-r border-border px-2 py-2 text-right font-medium">Planned</th>
              <th className="border-b border-r border-border px-2 py-2 text-right font-medium">Logged</th>
              {data.weeks.map((w) => <th key={w} className="min-w-[64px] border-b border-border px-1 py-2 text-center font-medium">{fmtShortDate(w)}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.userId}|${r.stageId}`}>
                <td className="border-b border-r border-border px-3 py-1.5"><span className="font-medium text-slate-800">{r.name}</span> <span className="text-muted-foreground">· {r.stage}</span></td>
                <td className="border-b border-r border-border px-2 py-1.5 text-right tabular-nums">{fmtHours(r.planned)}</td>
                <td className={cn("border-b border-r border-border px-2 py-1.5 text-right font-medium tabular-nums", drift(r.planned, r.logged))}>{fmtHours(r.logged)}</td>
                {r.weeks.map((w) => (
                  <td key={w.weekStart} className="border-b border-border px-1 py-1.5 text-center tabular-nums">
                    {w.planned || w.logged ? <><span className="text-slate-700">{w.planned ? fmtHours(w.planned) : "–"}</span><span className="text-muted-foreground"> / </span><span className={drift(w.planned, w.logged)}>{w.logged ? fmtHours(w.logged) : "–"}</span></> : <span className="text-slate-300">·</span>}
                  </td>
                ))}
              </tr>
            ))}
            {!data.rows.length && <tr><td colSpan={3 + data.weeks.length} className="px-3 py-6 text-center text-muted-foreground">Nothing planned or logged on this project in these weeks.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">Each week cell reads planned / logged. Green = on plan, amber = well under or unplanned, red = more than 10% over plan.</p>
    </div>
  );
}

function Legend({ mode }: { mode: "plan" | "heat" }) {
  if (mode === "heat") return <p className="mt-3 text-[11px] text-muted-foreground">Darker = more of the person&apos;s available hours are planned; red = over-allocated. The green bar is what they have logged so far that week.</p>;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded border border-emerald-200 bg-emerald-50" /> under 80% of available</span>
      <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded border border-amber-200 bg-amber-50" /> 80–100%</span>
      <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded border border-red-200 bg-red-50" /> over what they have (alert sent once)</span>
      <span>· available = capacity − holidays − approved leave</span>
    </div>
  );
}

function NavBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted">{children}</button>;
}
