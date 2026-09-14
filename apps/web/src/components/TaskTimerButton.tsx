import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Row 90: start / stop the timer straight from a task card. One timer runs
 * per person (starting here stops whatever else was running) and it lives on
 * the server, so a reload - or another device - shows it still ticking.
 */
export function TaskTimerButton({ taskId, label }: { taskId: string; label?: boolean }) {
  const qc = useQueryClient();
  const { data: running } = useQuery({ queryKey: ["timer"], queryFn: api.getRunningTimer, refetchOnWindowFocus: true });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["timer"] });
    qc.invalidateQueries({ queryKey: ["time-entries"] });
    qc.invalidateQueries({ queryKey: ["timesheet"] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const start = useMutation({ mutationFn: () => api.startTimer({ taskId }), onSuccess: refresh });
  const stop = useMutation({ mutationFn: api.stopTimer, onSuccess: refresh });
  const mine = running?.taskId === taskId;
  const busy = start.isPending || stop.isPending;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (mine) stop.mutate();
        else start.mutate();
      }}
      disabled={busy}
      title={mine ? "Stop the timer" : running ? "Start timing this task (stops the current timer)" : "Start timing this task"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition disabled:opacity-50",
        mine ? "bg-indigo-600 text-white hover:bg-indigo-700" : "text-slate-400 hover:bg-indigo-50 hover:text-indigo-700",
        !label && !mine && "opacity-0 group-hover:opacity-100",
      )}
    >
      <span aria-hidden>{mine ? "■" : "▶"}</span>
      {label && (mine ? "Stop timer" : "Start timer")}
      {mine && !label && <span className="animate-pulse">●</span>}
    </button>
  );
}
