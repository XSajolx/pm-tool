import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Avatar } from "./ui.js";
import { cn } from "../lib/utils.js";

/**
 * Row 103: each teammate's hours this week - project vs internal vs leave - as
 * a stacked bar against their expected hours. Over 100% turns red, under 60%
 * after mid-week turns amber, so rebalancing happens before Friday.
 */
const DAY = 86_400_000;

function fmtH(h: number) {
  return `${Math.round(h * 10) / 10}h`;
}

export function TeamWorkloadWidget({ compact }: { compact?: boolean }) {
  const [offset, setOffset] = useState(0);
  const week = new Date(Date.now() + offset * 7 * DAY).toISOString();
  const { data, isLoading } = useQuery({ queryKey: ["workload", week.slice(0, 10)], queryFn: () => api.getWorkload(week) });
  const people = data?.people ?? [];
  const weekStart = data ? new Date(data.weekStart) : null;
  const weekLabel = weekStart ? `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })} – ${new Date(weekStart.getTime() + 6 * DAY).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}` : "";
  // How far through the week are we? Used for the "running short" hint on the current week.
  const dayIdx = offset === 0 ? ((new Date().getUTCDay() + 6) % 7) + 1 : offset < 0 ? 7 : 0;
  const totals = people.reduce((a, p) => ({ project: a.project + p.projectHours, internal: a.internal + p.internalHours, leave: a.leave + p.leaveHours, expected: a.expected + p.expected }), { project: 0, internal: 0, leave: 0, expected: 0 });

  return (
    <section className="rounded-lg border border-border bg-white" data-testid="team-workload">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team workload</h2>
        <span className="text-xs text-muted-foreground">{weekLabel}</span>
        <div className="ml-auto flex items-center gap-1 text-xs">
          <button type="button" onClick={() => setOffset((o) => o - 1)} className="rounded border border-border px-1.5 py-0.5 hover:bg-slate-50" aria-label="Previous week">‹</button>
          <button type="button" onClick={() => setOffset(0)} disabled={offset === 0} className="rounded border border-border px-1.5 py-0.5 hover:bg-slate-50 disabled:opacity-40">This week</button>
          <button type="button" onClick={() => setOffset((o) => o + 1)} className="rounded border border-border px-1.5 py-0.5 hover:bg-slate-50" aria-label="Next week">›</button>
          {!compact && <Link to="/resourcing" className="ml-2 text-indigo-700 hover:underline">Resourcing →</Link>}
        </div>
      </div>
      <div className="p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !people.length ? (
          <p className="text-sm text-muted-foreground">No one has logged time this week.</p>
        ) : (
          <ul className="space-y-2.5">
            {people.map((p) => {
              const expected = p.expected || 0;
              const pct = expected ? (p.totalHours / expected) * 100 : 0;
              const over = expected > 0 && p.totalHours > expected;
              const expectedSoFar = expected ? (expected * Math.min(5, dayIdx)) / 5 : 0;
              const short = !over && expected > 0 && dayIdx >= 3 && p.totalHours < expectedSoFar * 0.6;
              const scale = Math.max(expected, p.totalHours) || 1;
              const seg = (h: number) => `${(h / scale) * 100}%`;
              const tip = `${p.name}: ${fmtH(p.projectHours)} project · ${fmtH(p.internalHours)} internal${p.leaveHours ? ` · ${fmtH(p.leaveHours)} leave` : ""} of ${fmtH(expected)} expected${p.projects.length ? `\n${p.projects.map((x) => `${x.name} ${fmtH(x.hours)}`).join(", ")}` : ""}`;
              return (
                <li key={p.userId} className="text-sm" title={tip}>
                  <div className="flex items-center gap-2">
                    <Avatar user={{ id: p.userId, name: p.name, avatarUrl: p.avatarUrl, email: "", role: "member" }} size={20} />
                    <span className="w-32 truncate text-slate-700">{p.name}</span>
                    <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div className="absolute inset-y-0 left-0 flex w-full">
                        <div className="h-full bg-indigo-500" style={{ width: seg(p.projectHours) }} />
                        <div className="h-full bg-slate-400" style={{ width: seg(p.internalHours) }} />
                        <div className="h-full bg-teal-400" style={{ width: seg(p.leaveHours) }} />
                      </div>
                      {expected > 0 && p.totalHours > expected && (
                        <div className="absolute inset-y-0 w-px bg-red-600" style={{ left: seg(expected) }} title={`Expected ${fmtH(expected)}`} />
                      )}
                    </div>
                    <span className={cn("w-28 text-right text-xs tabular-nums", over ? "font-semibold text-red-600" : short ? "text-amber-700" : "text-slate-600")}>
                      {fmtH(p.totalHours)} / {fmtH(expected)}
                      {expected ? <span className="text-muted-foreground"> · {Math.round(pct)}%</span> : null}
                    </span>
                  </div>
                  {(over || short) && (
                    <p className={cn("ml-[136px] mt-0.5 text-[11px]", over ? "text-red-600" : "text-amber-700")}>
                      {over ? `${fmtH(p.totalHours - expected)} over capacity` : `running short - ${fmtH(expectedSoFar - p.totalHours)} behind pace`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {people.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-indigo-500" /> project {fmtH(totals.project)}</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-slate-400" /> internal {fmtH(totals.internal)}</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-teal-400" /> leave {fmtH(totals.leave)}</span>
            <span className="ml-auto tabular-nums">team {fmtH(totals.project + totals.internal + totals.leave)} / {fmtH(totals.expected)} expected</span>
          </div>
        )}
      </div>
    </section>
  );
}
