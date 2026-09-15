import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type Project, type ProjectStatus } from "../lib/api.js";
import { Avatar } from "../components/ui.js";
import { fmtDuration, fmtShortDate } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { PROJECT_STATUS } from "./ProjectsPage.js";
import { cn } from "../lib/utils.js";
import { ExportCsvButton } from "../components/ExportCsvButton.js";

/**
 * Row 100: one page listing every project with status, PM, current stage,
 * open / overdue tasks, hours this week and the next milestone. Filters can be
 * saved by name; they live in this browser (per user) so nobody else's list
 * changes when you tweak yours.
 */
type SortKey = "name" | "status" | "lead" | "stage" | "open" | "overdue" | "week" | "milestone";
interface Filters {
  status: ProjectStatus | "all";
  leadId: string;
  stage: string;
  overdueOnly: boolean;
  q: string;
  sort: SortKey;
  dir: "asc" | "desc";
}
const DEFAULT_FILTERS: Filters = { status: "active", leadId: "", stage: "", overdueOnly: false, q: "", sort: "name", dir: "asc" };
interface SavedFilter { id: string; name: string; filters: Filters }

function storageKey(userId: string) {
  return `overview-filters:${userId}`;
}
function loadSaved(userId: string): SavedFilter[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? (JSON.parse(raw) as SavedFilter[]) : [];
  } catch {
    return [];
  }
}

export function OverviewPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "anon";
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [saved, setSaved] = useState<SavedFilter[]>(() => loadSaved(userId));
  const [activeSaved, setActiveSaved] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setSaved(loadSaved(userId)), [userId]);

  const includeArchived = filters.status === "archived" || filters.status === "all";
  const { data: projects = [], isLoading } = useQuery({ queryKey: ["projects", includeArchived], queryFn: () => api.getProjects(includeArchived) });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });

  const stageNames = useMemo(() => Array.from(new Set(projects.map((p) => p.stats.currentStage?.name).filter(Boolean) as string[])).sort(), [projects]);

  const rows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const list = projects.filter((p) => {
      if (filters.status !== "all" && p.status !== filters.status) return false;
      if (filters.leadId && p.leadId !== filters.leadId) return false;
      if (filters.stage && p.stats.currentStage?.name !== filters.stage) return false;
      if (filters.overdueOnly && !(p.stats.tasksOverdue > 0 || p.stats.nextMilestone?.overdue)) return false;
      if (q && !`${p.name} ${p.clientName ?? ""} ${p.company?.name ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const key = (p: Project): string | number => {
      switch (filters.sort) {
        case "status": return p.status;
        case "lead": return p.lead?.name ?? "";
        case "stage": return p.stats.currentStage?.name ?? "";
        case "open": return p.stats.tasksOpen;
        case "overdue": return p.stats.tasksOverdue;
        case "week": return p.stats.weekSeconds;
        case "milestone": return p.stats.nextMilestone?.targetDate ?? "9999";
        default: return p.name.toLowerCase();
      }
    };
    list.sort((a, b) => {
      const ka = key(a), kb = key(b);
      const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      return filters.dir === "asc" ? c : -c;
    });
    return list;
  }, [projects, filters]);

  const persist = (next: SavedFilter[]) => {
    setSaved(next);
    try { localStorage.setItem(storageKey(userId), JSON.stringify(next)); } catch { /* private mode */ }
  };
  const saveCurrent = () => {
    const name = saveName.trim();
    if (!name) return;
    const existing = saved.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const entry: SavedFilter = { id: existing?.id ?? crypto.randomUUID(), name, filters };
    persist(existing ? saved.map((s) => (s.id === entry.id ? entry : s)) : [...saved, entry]);
    setActiveSaved(entry.id);
    setSaveName("");
    setSaving(false);
  };
  const apply = (f: SavedFilter) => { setFilters(f.filters); setActiveSaved(f.id); };
  const remove = (id: string) => { persist(saved.filter((s) => s.id !== id)); if (activeSaved === id) setActiveSaved(null); };
  const set = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setActiveSaved(null); };
  const sortBy = (k: SortKey) => setFilters((f) => ({ ...f, sort: k, dir: f.sort === k && f.dir === "asc" ? "desc" : "asc" }));

  const totals = {
    open: rows.reduce((a, p) => a + p.stats.tasksOpen, 0),
    overdue: rows.reduce((a, p) => a + p.stats.tasksOverdue, 0),
    week: rows.reduce((a, p) => a + p.stats.weekSeconds, 0),
  };

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Workspace overview</h1>
        <span className="text-xs text-muted-foreground">
          {rows.length} project{rows.length === 1 ? "" : "s"} · {totals.open} open · {totals.overdue} overdue · {fmtDuration(totals.week)} this week
        </span>
        <span className="ml-auto" />
        <ExportCsvButton
          rows={rows}
          filename="projects-overview"
          columns={[
            { header: "Project", value: (p) => p.name },
            { header: "Client", value: (p) => p.company?.name ?? p.clientName ?? "" },
            { header: "Status", value: (p) => p.status },
            { header: "PM", value: (p) => p.lead?.name ?? "" },
            { header: "Current stage", value: (p) => p.stats.currentStage?.name ?? "" },
            { header: "Stage %", value: (p) => p.stats.currentStage?.progressPct ?? "" },
            { header: "Open tasks", value: (p) => p.stats.tasksOpen },
            { header: "Overdue tasks", value: (p) => p.stats.tasksOverdue },
            { header: "Hours this week", value: (p) => Math.round((p.stats.weekSeconds / 3600) * 100) / 100 },
            { header: "Next milestone", value: (p) => p.stats.nextMilestone?.name ?? "" },
            { header: "Milestone due", value: (p) => p.stats.nextMilestone?.targetDate?.slice(0, 10) ?? "" },
          ]}
        />
        <Link to="/projects" className="text-xs text-indigo-700 hover:underline">Project cards →</Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-slate-50/60 px-6 py-2 text-xs">
        <input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search project or client…" className="w-48 rounded-md border border-border bg-white px-2 py-1 outline-none focus:border-indigo-400" />
        <select value={filters.status} onChange={(e) => set({ status: e.target.value as Filters["status"] })} className="rounded-md border border-border bg-white px-2 py-1" aria-label="Status">
          <option value="all">All statuses</option>
          {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => (
            <option key={s} value={s}>{PROJECT_STATUS[s].label}</option>
          ))}
        </select>
        <select value={filters.leadId} onChange={(e) => set({ leadId: e.target.value })} className="rounded-md border border-border bg-white px-2 py-1" aria-label="Project manager">
          <option value="">Any PM</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <select value={filters.stage} onChange={(e) => set({ stage: e.target.value })} className="rounded-md border border-border bg-white px-2 py-1" aria-label="Current stage">
          <option value="">Any stage</option>
          {stageNames.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-slate-700">
          <input type="checkbox" checked={filters.overdueOnly} onChange={(e) => set({ overdueOnly: e.target.checked })} className="accent-indigo-600" />
          Overdue only
        </label>
        {JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) && (
          <button type="button" onClick={() => { setFilters(DEFAULT_FILTERS); setActiveSaved(null); }} className="text-muted-foreground hover:text-slate-700">Reset</button>
        )}

        <span className="mx-1 h-4 w-px bg-border" />
        {saved.map((f) => (
          <span key={f.id} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", activeSaved === f.id ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-700")}>
            <button type="button" onClick={() => apply(f)} className="hover:underline">{f.name}</button>
            <button type="button" onClick={() => remove(f.id)} className="text-muted-foreground hover:text-red-600" title="Delete saved filter" aria-label={`Delete ${f.name}`}>×</button>
          </span>
        ))}
        {saving ? (
          <form onSubmit={(e) => { e.preventDefault(); saveCurrent(); }} className="flex items-center gap-1">
            <input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Filter name" className="w-32 rounded-md border border-border bg-white px-2 py-1 outline-none focus:border-indigo-400" />
            <button type="submit" className="rounded-md bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700">Save</button>
            <button type="button" onClick={() => setSaving(false)} className="text-muted-foreground hover:text-slate-700">Cancel</button>
          </form>
        ) : (
          <button type="button" onClick={() => setSaving(true)} className="rounded-md border border-border bg-white px-2 py-1 text-slate-700 hover:border-indigo-300 hover:text-indigo-700">
            + Save filter
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length ? (
          <table className="w-full min-w-[900px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <Th k="name" cur={filters} onClick={sortBy}>Project</Th>
                <Th k="status" cur={filters} onClick={sortBy}>Status</Th>
                <Th k="lead" cur={filters} onClick={sortBy}>PM</Th>
                <Th k="stage" cur={filters} onClick={sortBy}>Current stage</Th>
                <Th k="open" cur={filters} onClick={sortBy} right>Open</Th>
                <Th k="overdue" cur={filters} onClick={sortBy} right>Overdue</Th>
                <Th k="week" cur={filters} onClick={sortBy} right>This week</Th>
                <Th k="milestone" cur={filters} onClick={sortBy}>Next milestone</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const st = PROJECT_STATUS[p.status];
                const stage = p.stats.currentStage;
                const ms = p.stats.nextMilestone;
                return (
                  <tr key={p.id} className="group border-b border-border hover:bg-slate-50">
                    <td className="border-b border-border py-2 pr-3">
                      <Link to="/projects/$projectId" params={{ projectId: p.id }} className="flex items-center gap-2 font-medium text-slate-800 hover:text-indigo-700">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                        <span className="truncate">{p.name}</span>
                      </Link>
                      {(p.company?.name || p.clientName) && <p className="pl-[18px] text-xs text-muted-foreground">{p.company?.name ?? p.clientName}</p>}
                    </td>
                    <td className="border-b border-border py-2 pr-3">
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
                    </td>
                    <td className="border-b border-border py-2 pr-3">
                      {p.lead ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-700">
                          <Avatar user={{ id: p.lead.id, name: p.lead.name, avatarUrl: p.lead.avatarUrl, email: "", role: "member" }} size={18} />
                          {p.lead.name}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="border-b border-border py-2 pr-3 text-xs">
                      {stage ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className={cn("h-1.5 w-1.5 rounded-full", stage.status === "active" ? "bg-indigo-500" : "bg-slate-300")} />
                          <span className="text-slate-700">{stage.name}</span>
                          <span className="text-muted-foreground">{stage.index}/{stage.count}</span>
                          <span className="tabular-nums text-slate-500" title="Percent complete, set by hand">{stage.progressPct}%</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="border-b border-border py-2 pr-3 text-right tabular-nums text-slate-700">{p.stats.tasksOpen}</td>
                    <td className={cn("border-b border-border py-2 pr-3 text-right tabular-nums", p.stats.tasksOverdue ? "font-semibold text-red-600" : "text-muted-foreground")}>{p.stats.tasksOverdue || "–"}</td>
                    <td className="border-b border-border py-2 pr-3 text-right tabular-nums text-slate-700">{p.stats.weekSeconds ? fmtDuration(p.stats.weekSeconds) : <span className="text-muted-foreground">–</span>}</td>
                    <td className="border-b border-border py-2 text-xs">
                      {ms ? (
                        <span className={cn(ms.overdue ? "text-red-600" : "text-slate-700")}>
                          {ms.name}
                          {ms.targetDate && <span className="text-muted-foreground"> · {ms.overdue ? "was due" : "due"} {fmtShortDate(ms.targetDate)}</span>}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">No projects match these filters.</p>
        )}
      </div>
    </div>
  );
}

function Th({ k, cur, onClick, right, children }: { k: SortKey; cur: Filters; onClick: (k: SortKey) => void; right?: boolean; children: React.ReactNode }) {
  const active = cur.sort === k;
  return (
    <th className={cn("border-b border-border pb-2 pr-3 font-medium", right && "text-right")}>
      <button type="button" onClick={() => onClick(k)} className={cn("hover:text-slate-700", active && "text-slate-800")}>
        {children}
        {active ? (cur.dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
}
