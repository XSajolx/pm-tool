import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { fmtClock } from "../lib/format.js";

/**
 * The always-visible timer in the sidebar. Ticks locally from `startedAt`
 * rather than polling, so it costs nothing while running; the server is only
 * asked on start/stop and when the tab regains focus.
 */
export function TimerBar() {
  const qc = useQueryClient();
  const { data: running } = useQuery({
    queryKey: ["timer"],
    queryFn: api.getRunningTimer,
    refetchOnWindowFocus: true,
  });
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.getProjects(),
  });

  const [projectId, setProjectId] = useState("");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const startedAt = new Date(running.startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["timer"] });
    qc.invalidateQueries({ queryKey: ["time-entries"] });
    qc.invalidateQueries({ queryKey: ["timesheet"] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const start = useMutation({
    mutationFn: () => api.startTimer({ projectId }),
    onSuccess: refresh,
  });
  const stop = useMutation({ mutationFn: api.stopTimer, onSuccess: refresh });

  const active = projects.filter((p) => p.status === "active");

  if (running) {
    return (
      <div className="mx-2 mb-2 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-2">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 animate-pulse rounded-full"
            style={{ background: running.project.color }}
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-indigo-900">
            {running.project.name}
          </span>
          <span className="font-mono text-xs tabular-nums text-indigo-700">
            {fmtClock(elapsed)}
          </span>
        </div>
        <button
          onClick={() => stop.mutate()}
          disabled={stop.isPending}
          className="mt-1.5 w-full rounded bg-indigo-600 py-1 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
        >
          Stop
        </button>
      </div>
    );
  }

  return (
    <div className="mx-2 mb-2 flex gap-1">
      <select
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
      >
        <option value="">Track time on…</option>
        {active.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => start.mutate()}
        disabled={!projectId || start.isPending}
        title="Start timer"
        className="rounded-md bg-indigo-600 px-2.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
      >
        ▶
      </button>
    </div>
  );
}
