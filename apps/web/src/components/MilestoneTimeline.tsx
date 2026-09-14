import { useMemo } from "react";
import type { Milestone } from "../lib/api.js";
import { fmtShortDate } from "../lib/format.js";
import { cn } from "../lib/utils.js";

/**
 * Row 101: milestones on one horizontal axis. Each row shows the target (hollow)
 * and the reached date (filled); the bar between them is the slip. Unreached
 * milestones past their target stretch a red dashed bar to today, so slippage is
 * visible before anyone marks anything.
 */
const DAY = 86_400_000;

function dayOf(iso: string) {
  return Math.floor(new Date(iso).getTime() / DAY);
}

export function MilestoneTimeline({ milestones, startDate, endDate }: { milestones: Milestone[]; startDate?: string | null; endDate?: string | null }) {
  const today = Math.floor(Date.now() / DAY);
  const model = useMemo(() => {
    const dated = milestones.filter((m) => m.targetDate || m.reachedAt);
    if (!dated.length) return null;
    const days: number[] = [today];
    if (startDate) days.push(dayOf(startDate));
    if (endDate) days.push(dayOf(endDate));
    for (const m of dated) {
      if (m.targetDate) days.push(dayOf(m.targetDate));
      if (m.reachedAt) days.push(dayOf(m.reachedAt));
    }
    let min = Math.min(...days);
    let max = Math.max(...days);
    const span = Math.max(14, max - min);
    const pad = Math.max(2, Math.round(span * 0.08));
    min -= pad;
    max = min + span + pad * 2;
    const total = max - min;
    const x = (day: number) => ((day - min) / total) * 100;

    // Month ticks along the top.
    const ticks: { x: number; label: string }[] = [];
    const first = new Date(min * DAY);
    const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
    while (cursor.getTime() / DAY <= max) {
      ticks.push({ x: x(cursor.getTime() / DAY), label: cursor.toLocaleDateString(undefined, { month: "short", year: total > 400 ? "2-digit" : undefined, timeZone: "UTC" }) });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    if (ticks.length > 14) {
      const keep = Math.ceil(ticks.length / 12);
      ticks.splice(0, ticks.length, ...ticks.filter((_, i) => i % keep === 0));
    }

    const rows = dated
      .map((m) => {
        const target = m.targetDate ? dayOf(m.targetDate) : null;
        const reached = m.reachedAt ? dayOf(m.reachedAt) : null;
        const late = target != null && reached == null && target < today ? today - target : 0;
        const slip = target != null && reached != null ? reached - target : null;
        return { m, target, reached, late, slip, tx: target != null ? x(target) : null, rx: reached != null ? x(reached) : null };
      })
      .sort((a, b) => (a.target ?? a.reached ?? 0) - (b.target ?? b.reached ?? 0));

    return { rows, ticks, todayX: x(today), min, max };
  }, [milestones, startDate, endDate, today]);

  if (!model) return null;
  const { rows, ticks, todayX } = model;
  const todayInRange = todayX >= 0 && todayX <= 100;

  return (
    <div className="mb-4 rounded-md border border-border bg-slate-50/50 p-3" data-testid="milestone-timeline">
      <div className="grid grid-cols-[minmax(120px,180px)_1fr] gap-x-3">
        {/* Axis */}
        <div className="text-[10px] text-muted-foreground">Timeline</div>
        <div className="relative h-4 border-b border-border">
          {ticks.map((t) => (
            <span key={t.label + t.x} className="absolute -translate-x-1/2 text-[10px] text-muted-foreground" style={{ left: `${t.x}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        {rows.map(({ m, target, reached, late, slip, tx, rx }) => {
          const slipped = slip != null && slip > 0;
          const early = slip != null && slip < 0;
          const barFrom = tx != null && rx != null ? Math.min(tx, rx) : tx != null && late ? tx : null;
          const barTo = tx != null && rx != null ? Math.max(tx, rx) : tx != null && late ? todayX : null;
          const status = reached != null
            ? slipped ? `reached ${slip}d late` : early ? `reached ${-slip}d early` : "reached on target"
            : late ? `${late}d past target` : target != null ? `due ${fmtShortDate(m.targetDate!)}` : "no target";
          return (
            <div key={m.id} className="contents">
              <div className="flex min-w-0 items-center gap-1.5 py-1.5 text-xs">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", reached != null ? (slipped ? "bg-amber-500" : "bg-green-500") : late ? "bg-red-500" : "bg-slate-300")} />
                <span className="truncate text-slate-700" title={`${m.name} · ${status}`}>{m.name}</span>
              </div>
              <div className="relative h-7">
                <div className="absolute left-0 right-0 top-1/2 h-px bg-border" />
                {todayInRange && <div className="absolute top-0 bottom-0 w-px border-l border-dashed border-indigo-300" style={{ left: `${todayX}%` }} />}
                {barFrom != null && barTo != null && barTo > barFrom && (
                  <div
                    className={cn("absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full", reached != null ? (slipped ? "bg-amber-400" : "bg-green-400") : "bg-red-300")}
                    style={{ left: `${barFrom}%`, width: `${barTo - barFrom}%`, backgroundImage: reached == null ? "repeating-linear-gradient(90deg, transparent 0 4px, rgba(255,255,255,0.7) 4px 6px)" : undefined }}
                    title={status}
                  />
                )}
                {tx != null && (
                  <span
                    className={cn("absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 bg-white", late ? "border-red-500" : "border-slate-500")}
                    style={{ left: `${tx}%` }}
                    title={`Target ${fmtShortDate(m.targetDate!)}`}
                    aria-label={`${m.name} target ${fmtShortDate(m.targetDate!)}`}
                  />
                )}
                {rx != null && (
                  <span
                    className={cn("absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full", slipped ? "bg-amber-500" : "bg-green-500")}
                    style={{ left: `${rx}%` }}
                    title={`Reached ${fmtShortDate(m.reachedAt!)}`}
                    aria-label={`${m.name} reached ${fmtShortDate(m.reachedAt!)}`}
                  />
                )}
                <span
                  className={cn("absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px]", slipped || late ? "text-red-600" : "text-muted-foreground")}
                  style={(barTo ?? Math.max(tx ?? 0, rx ?? 0)) > 80 ? { right: `${100 - Math.min(tx ?? 100, rx ?? 100) + 1.5}%` } : { left: `${(barTo ?? Math.max(tx ?? 0, rx ?? 0)) + 1.5}%` }}
                >
                  {status}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rotate-45 border-2 border-slate-500 bg-white" /> target</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-green-500" /> reached</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-1 w-4 rounded-full bg-amber-400" /> slipped</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-1 w-4 rounded-full bg-red-300" /> past target, not reached</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 border-l border-dashed border-indigo-300" /> today</span>
      </div>
    </div>
  );
}
