import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TimesheetBoard as Board } from "../lib/api.js";
import { fmtHours } from "../lib/format.js";
import { cn } from "../lib/utils.js";

const STATUS: Record<Board["people"][number]["status"], { label: string; cls: string }> = {
  not_started: { label: "Not started", cls: "bg-slate-100 text-slate-600" },
  in_progress: { label: "In progress", cls: "bg-indigo-50 text-indigo-700" },
  submitted: { label: "Submitted", cls: "bg-amber-50 text-amber-800" },
  approved: { label: "Approved", cls: "bg-green-50 text-green-700" },
  rejected: { label: "Rejected", cls: "bg-red-50 text-red-700" },
  reopened: { label: "Unlocked", cls: "bg-amber-50 text-amber-800" },
};

/**
 * Row 97: week-by-person status board for project managers - who hasn't
 * started, who's short, who's waiting on approval - with one-click nudges
 * and a jump into each person's week.
 */
export function TimesheetBoard({ weekIso, onOpen }: { weekIso: string; onOpen: (userId: string) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["timesheet-board", weekIso], queryFn: () => api.getTimesheetBoard(weekIso) });
  const [nudged, setNudged] = useState<Set<string>>(new Set());
  const nudge = useMutation({
    mutationFn: (userId: string) => api.nudgeTimesheet(userId, weekIso),
    onSuccess: (_r, userId) => {
      setNudged((s) => new Set(s).add(userId));
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.decideTimesheet(id, { approve }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["timesheet-board"] }),
  });
  if (isLoading || !data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const counts = data.people.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }), {});
  const stragglers = data.people.filter((p) => p.status !== "approved" && p.status !== "submitted");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {(Object.keys(STATUS) as (keyof typeof STATUS)[]).map((k) =>
          counts[k] ? (
            <span key={k} className={cn("rounded-full px-2 py-0.5 font-medium", STATUS[k].cls)}>
              {counts[k]} {STATUS[k].label.toLowerCase()}
            </span>
          ) : null,
        )}
        <span className="ml-auto text-muted-foreground">{data.people.length} people · week of {new Date(data.weekStart).toLocaleDateString()}</span>
        {stragglers.length > 0 && (
          <button
            type="button"
            onClick={() => stragglers.forEach((p) => nudge.mutate(p.userId))}
            disabled={nudge.isPending}
            className="rounded-md border border-border bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-muted disabled:opacity-50"
            title="Remind everyone who hasn't submitted"
          >
            Nudge all {stragglers.length} stragglers
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Person</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Hours vs expected</th>
              <th className="px-3 py-2 text-left font-medium">Billable</th>
              <th className="px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.people.map((p) => {
              const pct = p.expected ? Math.min(100, Math.round((p.hours / p.expected) * 100)) : 0;
              const short = p.hours < p.expected;
              return (
                <tr key={p.userId} className="hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => onOpen(p.userId)} className="flex items-center gap-2 text-left hover:underline">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">
                        {p.name.split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase()}
                      </span>
                      <span>
                        <span className="block text-slate-800">{p.name}</span>
                        <span className="block text-[11px] text-muted-foreground">{p.email}</span>
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS[p.status].cls)} title={p.note ?? undefined}>
                      {STATUS[p.status].label}
                    </span>
                    {p.submittedAt && p.status === "submitted" && <span className="ml-1.5 text-[11px] text-muted-foreground">{new Date(p.submittedAt).toLocaleDateString()}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={cn("w-20 tabular-nums", short ? "text-amber-800" : "text-green-700")}>
                        {fmtHours(p.hours)} / {p.expected}h
                      </span>
                      <span className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-100">
                        <span className={cn("block h-full rounded-full", short ? "bg-amber-500" : "bg-green-500")} style={{ width: `${pct}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-600">{fmtHours(p.billableHours)}</td>
                  <td className="px-3 py-2 text-right text-xs">
                    {p.status === "submitted" && p.submissionId && (
                      <>
                        <button type="button" onClick={() => decide.mutate({ id: p.submissionId!, approve: true })} className="mr-2 rounded-md bg-green-600 px-2 py-1 font-medium text-white hover:bg-green-700">
                          Approve
                        </button>
                        <button type="button" onClick={() => onOpen(p.userId)} className="mr-2 text-slate-600 hover:underline">
                          Review
                        </button>
                      </>
                    )}
                    {p.status !== "approved" && p.status !== "submitted" && (
                      <button type="button" onClick={() => nudge.mutate(p.userId)} disabled={nudged.has(p.userId) || nudge.isPending} className="rounded-md border border-border px-2 py-1 font-medium text-slate-700 hover:bg-muted disabled:opacity-50">
                        {nudged.has(p.userId) ? "Nudged ✓" : "Nudge"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
