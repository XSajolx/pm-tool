import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtDayLabel, fmtHours, fmtShortDate, isoDay } from "../lib/format.js";
import { cn } from "../lib/utils.js";

const WEEK_MS = 7 * 86_400_000;

/**
 * Weekly grid: projects down, days across, hours in the cells. Typing into a
 * cell sets that day's total for the project; the API keeps live-tracked time
 * intact underneath. Admins can look at anyone's week.
 */
export function TimesheetPage() {
  const qc = useQueryClient();
  const { user, role } = useAuth();
  const isAdmin = role === "owner" || role === "admin";

  const [weekOf, setWeekOf] = useState(() => new Date());
  const [forUser, setForUser] = useState<string>("");
  const [extraRows, setExtraRows] = useState<string[]>([]);

  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers, enabled: isAdmin });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });

  const weekIso = weekOf.toISOString();
  const { data: sheet, isLoading } = useQuery({
    queryKey: ["timesheet", weekIso, forUser],
    queryFn: () => api.getTimesheet(weekIso, forUser || undefined),
  });

  const setCell = useMutation({
    mutationFn: (v: { projectId: string; date: string; hours: number }) =>
      api.setTimesheetCell({ ...v, userId: forUser || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timesheet"] });
      qc.invalidateQueries({ queryKey: ["time-entries"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  // Rows = projects with time this week, plus any the user added by hand.
  const rows = useMemo(() => {
    const base = sheet?.rows ?? [];
    const have = new Set(base.map((r) => r.projectId));
    const added = extraRows
      .filter((id) => !have.has(id))
      .map((id) => {
        const p = projects.find((x) => x.id === id);
        return { projectId: id, projectName: p?.name ?? "Project", color: p?.color ?? "#94a3b8", hours: [0, 0, 0, 0, 0, 0, 0], total: 0 };
      });
    return [...base, ...added];
  }, [sheet, extraRows, projects]);

  const addable = projects.filter((p) => p.status === "active" && !rows.some((r) => r.projectId === p.id));
  const editable = !forUser || forUser === user?.id || isAdmin;
  const weekStart = sheet ? new Date(sheet.weekStart) : null;
  const weekEnd = weekStart ? new Date(weekStart.getTime() + 6 * 86_400_000) : null;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Timesheets</h1>

        <div className="ml-4 flex items-center gap-1">
          <NavBtn onClick={() => setWeekOf(new Date(weekOf.getTime() - WEEK_MS))}>‹</NavBtn>
          <button onClick={() => setWeekOf(new Date())} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted">
            This week
          </button>
          <NavBtn onClick={() => setWeekOf(new Date(weekOf.getTime() + WEEK_MS))}>›</NavBtn>
          {weekStart && weekEnd && (
            <span className="ml-2 text-sm text-slate-600">
              {fmtShortDate(weekStart.toISOString())} – {fmtShortDate(weekEnd.toISOString())}
            </span>
          )}
        </div>

        {isAdmin && (
          <select value={forUser} onChange={(e) => setForUser(e.target.value)} className="ml-auto rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700">
            <option value="">My timesheet</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading || !sheet ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="inline-block min-w-full overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-[#fbfbfa] text-xs text-muted-foreground">
                  <th className="w-56 border-b border-r border-border px-3 py-2 text-left font-medium">Project</th>
                  {sheet.days.map((d, i) => {
                    const isToday = isoDay(new Date(d)) === isoDay(new Date());
                    return (
                      <th key={d} className={cn("w-20 border-b border-border px-2 py-2 text-center font-medium", isToday && "text-indigo-700", i >= 5 && "bg-slate-50/60")}>
                        {fmtDayLabel(d)}
                      </th>
                    );
                  })}
                  <th className="w-20 border-b border-l border-border px-2 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.projectId} className="group">
                    <td className="border-b border-r border-border px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                        <span className="truncate font-medium text-slate-800">{r.projectName}</span>
                      </span>
                    </td>
                    {r.hours.map((h, i) => (
                      <td key={i} className={cn("border-b border-border p-0", i >= 5 && "bg-slate-50/60")}>
                        <HourCell
                          value={h}
                          editable={editable}
                          onCommit={(v) => setCell.mutate({ projectId: r.projectId, date: sheet.days[i]!, hours: v })}
                        />
                      </td>
                    ))}
                    <td className="border-b border-l border-border px-2 py-1.5 text-right tabular-nums font-medium text-slate-800">
                      {r.total ? fmtHours(r.total) : "–"}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      Nothing logged this week. Add a project row below to start.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-[#fbfbfa] text-xs font-semibold text-slate-700">
                  <td className="border-r border-border px-3 py-2">Total</td>
                  {sheet.totals.map((t, i) => (
                    <td key={i} className={cn("px-2 py-2 text-center tabular-nums", i >= 5 && "bg-slate-50/60")}>
                      {t ? fmtHours(t) : "–"}
                    </td>
                  ))}
                  <td className="border-l border-border px-2 py-2 text-right tabular-nums">{fmtHours(sheet.grandTotal)}</td>
                </tr>
              </tfoot>
            </table>

            {editable && addable.length > 0 && (
              <div className="border-t border-border px-3 py-2">
                <select
                  value=""
                  onChange={(e) => e.target.value && setExtraRows((x) => [...x, e.target.value])}
                  className="rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
                >
                  <option value="">+ Add project row…</option>
                  {addable.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** An hours input that only writes on blur/Enter and only when the value changed. */
function HourCell({ value, editable, onCommit }: { value: number; editable: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? String(Math.round(value * 100) / 100) : "");

  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (!Number.isNaN(v) && Math.abs(v - value) > 0.001) onCommit(Math.max(0, v));
  };

  if (!editable) {
    return <div className="px-2 py-1.5 text-center tabular-nums text-slate-700">{value ? fmtHours(value) : "–"}</div>;
  }
  return (
    <input
      type="number"
      min="0"
      max="24"
      step="0.25"
      value={shown}
      placeholder="–"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="h-9 w-full bg-transparent text-center text-sm tabular-nums text-slate-800 outline-none placeholder:text-slate-300 focus:bg-indigo-50"
    />
  );
}

function NavBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-md border border-border px-2 py-1 text-sm text-slate-600 hover:bg-muted">
      {children}
    </button>
  );
}
