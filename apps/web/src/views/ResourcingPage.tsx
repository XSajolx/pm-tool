import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ResourcingBoard, type ResourcingCell } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtHours, fmtShortDate } from "../lib/format.js";
import { cn } from "../lib/utils.js";

const WEEK_MS = 7 * 86_400_000;
const WEEKS = 8;

/**
 * People × weeks. Each cell is planned hours against capacity, coloured by
 * utilization, with logged hours underneath so plan and reality sit together.
 * Admins click a cell to split the week across projects.
 */
export function ResourcingPage() {
  const qc = useQueryClient();
  const { role } = useAuth();
  const isAdmin = role === "owner" || role === "admin";
  const [from, setFrom] = useState(() => new Date());
  const [editing, setEditing] = useState<{ userId: string; week: string } | null>(null);

  const fromIso = from.toISOString();
  const { data: board, isLoading } = useQuery({
    queryKey: ["resourcing", fromIso],
    queryFn: () => api.getResourcing(fromIso, WEEKS),
  });

  // Row 98: approved / pending leave over the visible weeks, shown on each person's cells.
  const { data: leave = [] } = useQuery({
    queryKey: ["leave-calendar", fromIso],
    queryFn: () => api.getLeaveCalendar(fromIso, new Date(from.getTime() + WEEKS * 7 * 86_400_000).toISOString()),
  });
  const leaveFor = (userId: string, weekStart: string) => {
    const ws = new Date(weekStart).getTime();
    const we = ws + 7 * 86_400_000;
    return leave.filter((l) => l.userId === userId && new Date(l.startDate).getTime() < we && new Date(l.endDate).getTime() + 86_400_000 > ws);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ["resourcing"] });
  const setCapacity = useMutation({
    mutationFn: ({ userId, hours }: { userId: string; hours: number }) => api.setCapacity(userId, hours),
    onSuccess: refresh,
  });

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Resourcing</h1>
        <span className="text-xs text-muted-foreground">Planned hours vs capacity, {WEEKS} weeks</span>
        <div className="ml-auto flex items-center gap-1">
          <NavBtn onClick={() => setFrom(new Date(from.getTime() - WEEK_MS * 4))}>‹ 4w</NavBtn>
          <button onClick={() => setFrom(new Date())} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted">
            Today
          </button>
          <NavBtn onClick={() => setFrom(new Date(from.getTime() + WEEK_MS * 4))}>4w ›</NavBtn>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading || !board ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="inline-block min-w-full overflow-hidden rounded-lg border border-border bg-white">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-[#fbfbfa] text-xs text-muted-foreground">
                    <th className="w-52 border-b border-r border-border px-3 py-2 text-left font-medium">Person</th>
                    <th className="w-20 border-b border-r border-border px-2 py-2 text-center font-medium">Capacity</th>
                    {board.weeks.map((w) => (
                      <th key={w} className="min-w-[96px] border-b border-border px-2 py-2 text-center font-medium">
                        {fmtShortDate(w)}
                      </th>
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
                        {isAdmin ? (
                          <CapacityInput value={m.capacity} onCommit={(h) => setCapacity.mutate({ userId: m.userId, hours: h })} />
                        ) : (
                          <span className="tabular-nums text-slate-700">{m.capacity}h</span>
                        )}
                      </td>
                      {m.cells.map((c) => (
                        <td key={c.weekStart} className="relative border-b border-border p-1">
                          <Cell
                            cell={c}
                            capacity={m.capacity}
                            clickable={isAdmin}
                            onClick={() => setEditing({ userId: m.userId, week: c.weekStart })}
                          />
                          {leaveFor(m.userId, c.weekStart).map((l) => (
                            <span
                              key={l.id}
                              className={`pointer-events-none absolute left-1.5 top-1.5 rounded px-1 text-[10px] font-medium ${l.status === "approved" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}
                              title={`${l.name}: ${l.kind} ${new Date(l.startDate).toLocaleDateString()} → ${new Date(l.endDate).toLocaleDateString()} (${l.status})`}
                            >
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
            <Legend />
          </>
        )}
      </div>

      {editing && board && (
        <AllocationDialog
          board={board}
          userId={editing.userId}
          week={editing.week}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function utilizationTone(u: number) {
  if (u === 0) return "bg-white text-slate-400 border-border";
  if (u < 0.8) return "bg-emerald-50 text-emerald-800 border-emerald-200";
  if (u <= 1) return "bg-amber-50 text-amber-800 border-amber-200";
  return "bg-red-50 text-red-800 border-red-200";
}

function Cell({ cell, capacity, clickable, onClick }: { cell: ResourcingCell; capacity: number; clickable: boolean; onClick: () => void }) {
  const pct = Math.round(cell.utilization * 100);
  return (
    <button
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className={cn(
        "flex h-14 w-full flex-col items-center justify-center rounded-md border text-xs transition",
        utilizationTone(cell.utilization),
        clickable && "hover:ring-2 hover:ring-indigo-300",
      )}
      title={Object.keys(cell.byProject).length ? `${pct}% planned · ${fmtHours(cell.logged)} logged` : "Not planned"}
    >
      <span className="text-sm font-semibold tabular-nums">
        {cell.allocated ? `${fmtHours(cell.allocated)}` : "–"}
        {cell.allocated ? <span className="text-[10px] font-normal opacity-70"> / {capacity}h</span> : null}
      </span>
      <span className="text-[10px] tabular-nums opacity-70">
        {cell.logged ? `${fmtHours(cell.logged)} logged` : cell.allocated ? `${pct}%` : ""}
      </span>
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
        if (draft === null) return;
        const v = Number(draft);
        setDraft(null);
        if (!Number.isNaN(v) && v !== value) onCommit(v);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="w-14 rounded border border-transparent bg-transparent text-center text-sm tabular-nums text-slate-700 outline-none hover:border-border focus:border-indigo-400 focus:bg-indigo-50"
    />
  );
}

/** Split one person's week across projects. Zero removes that project's row. */
function AllocationDialog({
  board,
  userId,
  week,
  onClose,
  onSaved,
}: {
  board: ResourcingBoard;
  userId: string;
  week: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const member = board.members.find((m) => m.userId === userId)!;
  const cell = member.cells.find((c) => c.weekStart === week)!;
  const [hours, setHours] = useState<Record<string, string>>(() =>
    Object.fromEntries(board.projects.map((p) => [p.id, cell.byProject[p.id] ? String(cell.byProject[p.id]) : ""])),
  );

  const save = useMutation({
    mutationFn: async () => {
      for (const p of board.projects) {
        const next = Number(hours[p.id] || 0);
        const prev = cell.byProject[p.id] ?? 0;
        if (Math.abs(next - prev) > 0.001) {
          await api.setAllocation({ userId, projectId: p.id, weekStart: week, hours: next });
        }
      }
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const total = board.projects.reduce((a, p) => a + Number(hours[p.id] || 0), 0);
  const over = total > member.capacity;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">{member.name}</h2>
        <p className="text-xs text-muted-foreground">Week of {fmtShortDate(week)} · capacity {member.capacity}h</p>

        <div className="mt-4 space-y-2">
          {board.projects.length ? (
            board.projects.map((p) => (
              <label key={p.id} className="flex items-center gap-3">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{p.name}</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={hours[p.id] ?? ""}
                  onChange={(e) => setHours((h) => ({ ...h, [p.id]: e.target.value }))}
                  placeholder="0"
                  className="w-20 rounded-md border border-border px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-indigo-500"
                />
                <span className="w-4 text-xs text-muted-foreground">h</span>
              </label>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No active projects to plan against.</p>
          )}
        </div>

        <div className={cn("mt-4 flex items-center justify-between rounded-md px-3 py-2 text-sm", over ? "bg-red-50 text-red-700" : "bg-muted text-slate-700")}>
          <span>Planned</span>
          <span className="font-semibold tabular-nums">
            {fmtHours(total)} / {member.capacity}h{over ? " — over capacity" : ""}
          </span>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-emerald-200 bg-emerald-50" /> under 80%</span>
      <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-amber-200 bg-amber-50" /> 80–100%</span>
      <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-red-200 bg-red-50" /> over capacity</span>
    </div>
  );
}

function NavBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-md border border-border px-2 py-1 text-xs text-slate-600 hover:bg-muted">
      {children}
    </button>
  );
}
