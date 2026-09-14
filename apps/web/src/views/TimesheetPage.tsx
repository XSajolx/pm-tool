import { useEffect, useMemo, useState } from "react";
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
  // Row 88: hand-added rows are project or project+task. Row 89: they're remembered per week
  // (browser-side) so a copied set of rows survives a reload even before hours are typed.
  type ExtraRow = { projectId: string; taskId: string | null; taskTitle?: string | null };
  const [extraRows, setExtraRows] = useState<ExtraRow[]>([]);

  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers, enabled: isAdmin });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });

  const weekIso = weekOf.toISOString();
  const { data: sheet, isLoading } = useQuery({
    queryKey: ["timesheet", weekIso, forUser],
    queryFn: () => api.getTimesheet(weekIso, forUser || undefined),
  });

  const setCell = useMutation({
    mutationFn: (v: { projectId: string; taskId?: string | null; date: string; hours: number }) =>
      api.setTimesheetCell({ ...v, userId: forUser || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timesheet"] });
      qc.invalidateQueries({ queryKey: ["time-entries"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const rowsKey = sheet ? `ts-rows:${sheet.userId}:${sheet.weekStart.slice(0, 10)}` : null;
  useEffect(() => {
    if (!rowsKey) return;
    try {
      const saved = localStorage.getItem(rowsKey);
      setExtraRows(saved ? (JSON.parse(saved) as ExtraRow[]) : []);
    } catch {
      setExtraRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey]);
  const rememberRows = (next: ExtraRow[]) => {
    setExtraRows(next);
    if (rowsKey) {
      try {
        localStorage.setItem(rowsKey, JSON.stringify(next));
      } catch {
        /* storage blocked - rows still show for this visit */
      }
    }
  };

  // Row 89: copy last week's rows (projects / tasks) into this week - rows only, never the hours.
  const copyPrevWeek = useMutation({
    mutationFn: () => api.getTimesheet(new Date(weekOf.getTime() - WEEK_MS).toISOString(), forUser || undefined),
    onSuccess: (prev) => {
      const have = new Set([...(sheet?.rows ?? []), ...extraRows].map((r) => `${r.projectId}:${r.taskId ?? ""}`));
      const fresh = prev.rows
        .filter((r) => !have.has(`${r.projectId}:${r.taskId ?? ""}`))
        .map((r) => ({ projectId: r.projectId, taskId: r.taskId, taskTitle: r.taskTitle }));
      rememberRows([...extraRows, ...fresh]);
    },
  });

  // Row 75: submit my week; the approver gets an inbox card.
  const submit = useMutation({
    mutationFn: () => api.submitTimesheet(weekIso),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["timesheet"] }),
  });

  // Rows = projects with time this week, plus any the user added by hand.
  const rows = useMemo(() => {
    const base = sheet?.rows ?? [];
    const key = (r: { projectId: string; taskId: string | null }) => `${r.projectId}:${r.taskId ?? ""}`;
    const have = new Set(base.map(key));
    const added = extraRows
      .filter((x) => !have.has(key(x)))
      .map((x) => {
        const p = projects.find((pr) => pr.id === x.projectId);
        return { projectId: x.projectId, projectName: p?.name ?? "Project", color: p?.color ?? "#94a3b8", taskId: x.taskId, taskTitle: x.taskTitle ?? null, taskReference: null, hours: [0, 0, 0, 0, 0, 0, 0], total: 0 };
      });
    return [...base, ...added];
  }, [sheet, extraRows, projects]);

  const addable = projects.filter((p) => p.status === "active");
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
          {sheet && (
            <span
              className={cn("ml-3 inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums", sheet.grandTotal >= sheet.expectedHours ? "border-green-200 bg-green-50 text-green-700" : "border-border bg-white text-slate-700")}
              title="Logged this week vs your expected weekly hours"
            >
              {fmtHours(sheet.grandTotal)}/{sheet.expectedHours}h
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                <span className="block h-full rounded-full bg-indigo-500" style={{ width: `${Math.min(100, Math.round((sheet.grandTotal / Math.max(1, sheet.expectedHours)) * 100))}%` }} />
              </span>
            </span>
          )}
        </div>

        {sheet && !forUser && (
          <div className="ml-auto flex items-center gap-2">
            {sheet.submission?.status === "approved" && (
              <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">✓ Approved</span>
            )}
            {sheet.submission?.status === "submitted" && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">Awaiting approval</span>
            )}
            {sheet.submission?.status === "rejected" && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700" title={sheet.submission.note ?? undefined}>
                Sent back{sheet.submission.note ? `: ${sheet.submission.note}` : ""}
              </span>
            )}
            {(!sheet.submission || sheet.submission.status === "rejected") && (
              <button
                type="button"
                onClick={() => submit.mutate()}
                disabled={submit.isPending || !sheet.grandTotal}
                title={sheet.grandTotal ? "Send this week to your approver's inbox" : "Log some time first"}
                className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {sheet.submission ? "Resubmit week" : "Submit week for approval"}
              </button>
            )}
            {submit.isError && <span className="text-xs text-red-600">{(submit.error as Error).message}</span>}
          </div>
        )}
        {isAdmin && (
          <select value={forUser} onChange={(e) => setForUser(e.target.value)} className={cn("rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700", forUser ? "ml-auto" : "")}>
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
                  <tr key={`${r.projectId}:${r.taskId ?? ""}`} className="group">
                    <td className="border-b border-r border-border px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-800">{r.projectName}</span>
                          {r.taskId && (
                            <span className="block truncate text-[11px] text-muted-foreground" title={r.taskTitle ?? undefined}>
                              {r.taskReference ? `${r.taskReference} · ` : "↳ "}
                              {r.taskTitle}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    {r.hours.map((h, i) => (
                      <td key={i} className={cn("border-b border-border p-0", i >= 5 && "bg-slate-50/60")}>
                        <HourCell
                          value={h}
                          editable={editable}
                          onCommit={(v) => setCell.mutate({ projectId: r.projectId, taskId: r.taskId, date: sheet.days[i]!, hours: v })}
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
              <AddRowPicker
                projects={addable}
                onAdd={(row) => rememberRows([...extraRows, row])}
                onCopyPrev={() => copyPrevWeek.mutate()}
                copying={copyPrevWeek.isPending}
                copied={copyPrevWeek.isSuccess ? copyPrevWeek.data.rows.length : null}
              />
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

/** Row 88: add a row for a project, or for one task inside it. */
function AddRowPicker({
  projects,
  onAdd,
  onCopyPrev,
  copying,
  copied,
}: {
  projects: { id: string; name: string }[];
  onAdd: (row: { projectId: string; taskId: string | null; taskTitle?: string | null }) => void;
  onCopyPrev: () => void;
  copying: boolean;
  copied: number | null;
}) {
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const { data: tasks = [] } = useQuery({ queryKey: ["pickable-tasks", projectId], queryFn: () => api.getPickableTasks(projectId), enabled: Boolean(projectId) });
  const sel = "rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700";
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
      <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setTaskId(""); }} className={sel}>
        <option value="">+ Add row for project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {projectId && (
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className={sel} title="Optional: a task inside the project">
          <option value="">Whole project</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.reference ? `${t.reference} ` : ""}
              {t.title}
            </option>
          ))}
        </select>
      )}
      {projectId && (
        <button
          type="button"
          onClick={() => {
            onAdd({ projectId, taskId: taskId || null, taskTitle: tasks.find((t) => t.id === taskId)?.title ?? null });
            setProjectId("");
            setTaskId("");
          }}
          className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
        >
          Add row
        </button>
      )}
      <span className="mx-1 h-4 w-px bg-border" />
      <button type="button" onClick={onCopyPrev} disabled={copying} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted disabled:opacity-50" title="Bring last week's project / task rows into this week - rows only, not the hours">
        {copying ? "Copying…" : "⧉ Copy last week's rows"}
      </button>
      {copied !== null && <span className="text-[11px] text-muted-foreground">{copied ? `${copied} row${copied === 1 ? "" : "s"} from last week` : "Last week had no rows"}</span>}
    </div>
  );
}

function NavBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-md border border-border px-2 py-1 text-sm text-slate-600 hover:bg-muted">
      {children}
    </button>
  );
}
