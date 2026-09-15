import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TimeEntry } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtDuration, isoDay } from "../lib/format.js";
import { cn } from "../lib/utils.js";
import { ExportCsvButton } from "../components/ExportCsvButton.js";

const DAYS_BACK = 14;

/** Your last two weeks of time, day by day, plus a form for logging by hand. */
export function TimeTrackingPage() {
  const qc = useQueryClient();
  const { user } = useAuth();

  const from = useMemo(() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - (DAYS_BACK - 1));
    return d.toISOString();
  }, []);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["time-entries", "mine", from],
    queryFn: () => api.getTimeEntries({ from }),
  });

  const remove = useMutation({
    mutationFn: api.deleteTimeEntry,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["time-entries"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const days = useMemo(() => groupByDay(entries), [entries]);
  const weekTotal = entries.reduce((a, e) => a + e.durationSeconds, 0);

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Time Tracking</h1>
        <span className="text-xs text-muted-foreground">Last {DAYS_BACK} days</span>
        <span className="ml-auto text-sm tabular-nums text-slate-700">
          Total <span className="font-semibold">{fmtDuration(weekTotal)}</span>
        </span>
        {/* Row 127 */}
        <ExportCsvButton
          rows={entries}
          filename="time-entries"
          columns={[
            { header: "Date", value: (e) => e.startedAt.slice(0, 10) },
            { header: "Person", value: (e) => e.user?.name ?? "" },
            { header: "Project", value: (e) => e.project.name },
            { header: "Task", value: (e) => (e.task ? `${e.task.reference ? `${e.task.reference} ` : ""}${e.task.title}` : "") },
            { header: "Description", value: (e) => e.description ?? "" },
            { header: "Started", value: (e) => e.startedAt },
            { header: "Ended", value: (e) => e.endedAt ?? "" },
            { header: "Hours", value: (e) => Math.round((e.durationSeconds / 3600) * 100) / 100 },
            { header: "Billable", value: (e) => (e.billable ? "yes" : "no") },
            { header: "Source", value: (e) => e.source },
          ]}
        />
      </div>

      <ManualEntryForm />

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : days.length ? (
          days.map((d) => (
            <section key={d.day} className="mb-5">
              <div className="mb-1.5 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-slate-800">{d.label}</h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {fmtDuration(d.total)}
                </span>
              </div>
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {d.items.map((e) => (
                  <li
                    key={e.id}
                    className="group flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.project.color }} />
                    <span className="w-40 shrink-0 truncate text-sm font-medium text-slate-800">
                      {e.project.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-600">
                      {e.description || e.task?.title || (
                        <span className="text-muted-foreground">No description</span>
                      )}
                      {e.task?.reference && (
                        <span className="ml-1.5 text-xs text-muted-foreground">{e.task.reference}</span>
                      )}
                      {e.description && e.task && (
                        <span className="ml-1.5 text-xs text-muted-foreground">· {e.task.title}</span>
                      )}
                    </span>
                    {e.stage && (
                      <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700" title="Stage">
                        {e.stage.name}
                      </span>
                    )}
                    {!e.billable && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                        non-billable
                      </span>
                    )}
                    <span className={cn("w-16 shrink-0 text-right text-sm tabular-nums", e.running ? "text-indigo-600" : "text-slate-700")}>
                      {e.running ? "running" : fmtDuration(e.durationSeconds)}
                    </span>
                    {e.userId === user?.id && !e.running && (
                      <button
                        onClick={() => remove.mutate(e.id)}
                        title="Delete entry"
                        className="shrink-0 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-500"
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">⏱️</span>
            <p className="text-sm text-muted-foreground">
              No time logged yet. Start the timer in the sidebar or add an entry above.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ManualEntryForm() {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.getProjects() });
  // Row 91: internal codes sit in the same picker, under their own heading.
  const { data: codes = [] } = useQuery({ queryKey: ["time-codes"], queryFn: () => api.getTimeCodes() });
  const [projectId, setProjectId] = useState("");
  // Row 87: optional stage + task on the entry.
  const [stageId, setStageId] = useState("");
  const [taskId, setTaskId] = useState("");
  const { data: stages = [] } = useQuery({ queryKey: ["stages", projectId], queryFn: () => api.getStages(projectId), enabled: Boolean(projectId) });
  const { data: pickable = [] } = useQuery({ queryKey: ["pickable-tasks", projectId], queryFn: () => api.getPickableTasks(projectId), enabled: Boolean(projectId) });
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(isoDay(new Date()));
  const [hours, setHours] = useState("1");
  const [billable, setBillable] = useState(true);

  const create = useMutation({
    mutationFn: () =>
      api.createTimeEntry({
        projectId,
        stageId: stageId || undefined,
        taskId: taskId || undefined,
        description: description.trim() || undefined,
        billable,
        startedAt: new Date(`${date}T09:00:00.000Z`).toISOString(),
        durationSeconds: Math.round(Number(hours) * 3600),
      }),
    onSuccess: () => {
      setDescription("");
      setTaskId("");
      qc.invalidateQueries({ queryKey: ["time-entries"] });
      qc.invalidateQueries({ queryKey: ["timesheet"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (projectId && Number(hours) > 0) create.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-b border-border bg-[#fbfbfa] px-6 py-2.5">
      <select
        value={projectId}
        onChange={(e) => {
          setProjectId(e.target.value);
          setStageId("");
          setTaskId("");
        }}
        className={input + " w-44"}
        required
      >
        <option value="">Project…</option>
        <optgroup label="Projects">
          {projects.filter((p) => p.status === "active").map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </optgroup>
        {codes.length > 0 && (
          <optgroup label="Internal">
            {codes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </optgroup>
        )}
      </select>
      {projectId && stages.length > 0 && (
        <select value={stageId} onChange={(e) => setStageId(e.target.value)} className={input + " w-36"} title="Stage (optional)">
          <option value="">Any stage</option>
          {stages.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
      )}
      {projectId && pickable.length > 0 && (
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className={input + " w-48"} title="Task (optional)">
          <option value="">No task</option>
          {pickable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.reference ? `${t.reference} ` : ""}
              {t.title}
            </option>
          ))}
        </select>
      )}
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What did you work on?"
        className={input + " min-w-[200px] flex-1"}
      />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input + " w-36"} />
      <input
        type="number"
        min="0.25"
        step="0.25"
        value={hours}
        onChange={(e) => setHours(e.target.value)}
        className={input + " w-20"}
        title="Hours"
      />
      <label className="flex items-center gap-1.5 text-xs text-slate-600">
        <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} className="accent-indigo-600" />
        Billable
      </label>
      <button
        type="submit"
        disabled={!projectId || create.isPending}
        className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
      >
        Log time
      </button>
      {create.isError && <span className="basis-full text-xs text-red-600">{(create.error as Error).message.replace(/^API \d+: /, "").replace(/^\{.*"message":"([^"]+)".*\}$/, "$1")}</span>}
    </form>
  );
}

const input =
  "rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

function groupByDay(entries: TimeEntry[]) {
  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - 86_400_000));
  const map = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const day = e.startedAt.slice(0, 10);
    (map.get(day) ?? map.set(day, []).get(day)!).push(e);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, items]) => ({
      day,
      label:
        day === today
          ? "Today"
          : day === yesterday
            ? "Yesterday"
            : new Date(day).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }),
      items,
      total: items.reduce((a, e) => a + e.durationSeconds, 0),
    }));
}
