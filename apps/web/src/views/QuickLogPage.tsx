import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { fmtClock, fmtDuration } from "../lib/format.js";
import { cn } from "../lib/utils.js";

const HOUR_CHIPS = [0.25, 0.5, 1, 2, 4, 8];

/**
 * Row 96: log today's hours or start a timer in three taps. Built for a phone:
 * one column, 44px+ targets, the projects you used recently first, and the
 * same API the desktop screens use - nothing special-cased on the server.
 */
export function QuickLogPage() {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });
  const { data: codes = [] } = useQuery({ queryKey: ["time-codes"], queryFn: () => api.getTimeCodes() });
  const { data: running } = useQuery({ queryKey: ["timer"], queryFn: api.getRunningTimer, refetchOnWindowFocus: true });
  const { data: recent = [] } = useQuery({
    queryKey: ["time-entries", "recent"],
    queryFn: () => api.getTimeEntries({ from: new Date(Date.now() - 14 * 86_400_000).toISOString() }),
  });

  const [projectId, setProjectId] = useState("");
  const [hours, setHours] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const startedAt = new Date(running.startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  // Recently used first, then everything else that's active, then internal codes.
  const choices = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string; color: string; hint?: string }[] = [];
    for (const e of recent) {
      if (seen.has(e.projectId)) continue;
      seen.add(e.projectId);
      out.push({ id: e.projectId, name: e.project.name, color: e.project.color, hint: "recent" });
    }
    for (const p of projects.filter((p) => p.status === "active")) if (!seen.has(p.id)) { seen.add(p.id); out.push({ id: p.id, name: p.name, color: p.color }); }
    for (const c of codes) if (!seen.has(c.id)) { seen.add(c.id); out.push({ id: c.id, name: c.name, color: c.color, hint: "internal" }); }
    return out;
  }, [recent, projects, codes]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["time-entries"] });
    qc.invalidateQueries({ queryKey: ["timesheet"] });
    qc.invalidateQueries({ queryKey: ["timer"] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };
  const log = useMutation({
    mutationFn: () => {
      const start = new Date();
      start.setHours(9, 0, 0, 0);
      return api.createTimeEntry({ projectId, description: note.trim() || undefined, startedAt: start.toISOString(), durationSeconds: Math.round((hours ?? 0) * 3600) });
    },
    onSuccess: () => {
      refresh();
      flash(`Logged ${fmtDuration(Math.round((hours ?? 0) * 3600))} today ✓`);
      setHours(null);
      setNote("");
    },
  });
  const start = useMutation({
    mutationFn: () => api.startTimer({ projectId, description: note.trim() || undefined }),
    onSuccess: () => {
      refresh();
      flash("Timer running ▶");
      setNote("");
    },
  });
  const stop = useMutation({ mutationFn: api.stopTimer, onSuccess: () => { refresh(); flash("Timer stopped - entry saved ✓"); } });

  const todayLogged = recent.filter((e) => e.startedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).reduce((a, e) => a + e.durationSeconds, 0);
  const chip = "flex min-h-[44px] items-center justify-center rounded-xl border px-3 text-sm font-medium transition active:scale-[0.98]";

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Log time</h1>
          <p className="text-xs text-muted-foreground">Today so far: {fmtDuration(todayLogged)}</p>
        </div>
        <Link to="/timesheets" className="text-xs font-medium text-indigo-600">Timesheet →</Link>
      </header>

      {running && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full" style={{ background: running.project.color }} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-indigo-900">{running.task?.title ?? running.project.name}</span>
            <span className="font-mono text-sm tabular-nums text-indigo-700">{fmtClock(elapsed)}</span>
          </div>
          <button type="button" onClick={() => stop.mutate()} disabled={stop.isPending} className="mt-2 flex min-h-[48px] w-full items-center justify-center rounded-xl bg-indigo-600 text-base font-semibold text-white active:scale-[0.98] disabled:opacity-60">
            ■ Stop timer
          </button>
        </div>
      )}

      <section>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">1 · What on</p>
        <div className="grid grid-cols-2 gap-2">
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setProjectId(c.id)}
              className={cn(chip, "justify-start gap-2 text-left", projectId === c.id ? "border-indigo-500 bg-indigo-50 text-indigo-900" : "border-border bg-white text-slate-700")}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.hint && <span className="text-[10px] font-normal text-muted-foreground">{c.hint}</span>}
            </button>
          ))}
          {!choices.length && <p className="col-span-2 text-sm text-muted-foreground">No projects yet.</p>}
        </div>
      </section>

      <section>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">2 · How long (today)</p>
        <div className="grid grid-cols-3 gap-2">
          {HOUR_CHIPS.map((h) => (
            <button key={h} type="button" onClick={() => setHours(h)} className={cn(chip, hours === h ? "border-indigo-500 bg-indigo-50 text-indigo-900" : "border-border bg-white text-slate-700")}>
              {h < 1 ? `${h * 60}m` : `${h}h`}
            </button>
          ))}
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="mt-2 min-h-[44px] w-full rounded-xl border border-border bg-white px-3 text-sm outline-none focus:border-indigo-500" />
      </section>

      <section className="grid gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">3 · Go</p>
        <button
          type="button"
          disabled={!projectId || !hours || log.isPending}
          onClick={() => log.mutate()}
          className="flex min-h-[52px] items-center justify-center rounded-xl bg-indigo-600 text-base font-semibold text-white active:scale-[0.98] disabled:opacity-40"
        >
          {log.isPending ? "Saving…" : `Log ${hours ? (hours < 1 ? `${hours * 60}m` : `${hours}h`) : "hours"} for today`}
        </button>
        {!running && (
          <button
            type="button"
            disabled={!projectId || start.isPending}
            onClick={() => start.mutate()}
            className="flex min-h-[52px] items-center justify-center rounded-xl border-2 border-indigo-600 bg-white text-base font-semibold text-indigo-700 active:scale-[0.98] disabled:opacity-40"
          >
            ▶ Start timer instead
          </button>
        )}
        {(log.isError || start.isError) && <p className="text-sm text-red-600">{((log.error ?? start.error) as Error).message.replace(/^API \d+: /, "").replace(/^\{.*"message":"([^"]+)".*\}$/, "$1")}</p>}
      </section>

      {toast && <div className="fixed inset-x-4 bottom-4 z-50 rounded-xl bg-slate-900 px-4 py-3 text-center text-sm font-medium text-white shadow-lg">{toast}</div>}
    </div>
  );
}
