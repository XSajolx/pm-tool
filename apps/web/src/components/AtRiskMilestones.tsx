import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { fmtShortDate } from "../lib/format.js";
import { cn } from "../lib/utils.js";

/**
 * Row 106: milestones whose target is within the org's risk window while linked
 * tasks are still open. The same rule feeds the inbox alert, so the dashboard
 * and the notification never disagree.
 */
export function AtRiskMilestones() {
  const { data } = useQuery({ queryKey: ["milestones-at-risk"], queryFn: api.getAtRiskMilestones, refetchInterval: 5 * 60_000 });
  if (!data || !data.items.length) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4" data-testid="at-risk-milestones">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-red-800">⚠ Milestones at risk</p>
        <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">{data.items.length}</span>
        <span className="ml-auto text-[11px] text-red-700/80">due within {data.days} days with open tasks · <Link to="/settings" className="underline">change window</Link></span>
      </div>
      <ul className="mt-2 space-y-1">
        {data.items.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2 text-sm text-red-900">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: m.project.color ?? "#ef4444" }} />
            <Link to="/projects/$projectId" params={{ projectId: m.project.id }} className="font-medium hover:underline">{m.name}</Link>
            <span className="text-xs text-red-700/80">{m.project.name}</span>
            <span className={cn("ml-auto text-xs tabular-nums", m.daysLeft < 0 ? "font-semibold" : "")}>
              {m.daysLeft < 0 ? `${-m.daysLeft}d past target` : m.daysLeft === 0 ? "due today" : `${m.daysLeft}d left`} · {fmtShortDate(m.targetDate)} · {m.openTasks}/{m.totalTasks} task{m.totalTasks === 1 ? "" : "s"} open
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
