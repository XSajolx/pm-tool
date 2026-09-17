import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type AgedReceivables, type KpiSnapshot, type Profitability, type Utilization, type WipReport } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

type Tab = "kpis" | "utilization" | "profitability" | "wip" | "receivables";
const TABS: { key: Tab; label: string; row: string }[] = [
  { key: "kpis", label: "KPI dashboard", row: "146" },
  { key: "utilization", label: "Utilization", row: "142" },
  { key: "profitability", label: "Profitability", row: "143" },
  { key: "wip", label: "Unbilled work (WIP)", row: "144" },
  { key: "receivables", label: "Aged receivables", row: "145" },
];

function monthStart() {
  const d = new Date();
  return isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
}

/**
 * Rows 142-146: the agency numbers in one place — every table clicks through
 * to its rows and every report has an Export CSV button. Owner/admin only.
 */
export function ReportsPage() {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get("tab") as Tab) || "kpis");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(isoDay(new Date()));
  if (!admin) return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">Reports are for owners and admins.</div>;
  const dated = tab === "utilization" || tab === "profitability";
  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden" data-testid="reports-page">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Reports</h1>
        <nav className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={cn("rounded-full border px-3 py-1 text-xs font-medium", tab === t.key ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:bg-muted")}>{t.label}</button>
          ))}
        </nav>
        {dated && (
          <span className="ml-auto flex items-center gap-1 text-xs">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={cn(input, "w-36")} />
            <span className="text-muted-foreground">→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={cn(input, "w-36")} />
          </span>
        )}
        {tab !== "kpis" && <ExportButton tab={tab as Exclude<Tab, "kpis">} from={from} to={to} className={dated ? "" : "ml-auto"} />}
      </div>
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-6xl">
          {tab === "kpis" && <Kpis onGo={setTab} />}
          {tab === "utilization" && <UtilizationTab from={from} to={to} />}
          {tab === "profitability" && <ProfitabilityTab from={from} to={to} />}
          {tab === "wip" && <WipTab />}
          {tab === "receivables" && <ReceivablesTab />}
        </div>
      </div>
    </div>
  );
}

function ExportButton({ tab, from, to, className }: { tab: Exclude<Tab, "kpis">; from: string; to: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.downloadReportCsv(tab, tab === "utilization" || tab === "profitability" ? { from, to } : {});
        } finally {
          setBusy(false);
        }
      }}
      className={cn("rounded-md border border-border px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-muted disabled:opacity-50", className)}
      data-testid="export-csv"
    >
      {busy ? "Exporting…" : "Export CSV"}
    </button>
  );
}

function Tile({ label, value, hint, tone, onClick }: { label: string; value: string; hint?: string; tone?: string; onClick?: () => void }) {
  const Cmp = onClick ? "button" : "div";
  return (
    <Cmp onClick={onClick} className={cn("rounded-lg border border-border bg-white p-3 text-left", onClick && "hover:border-indigo-300")}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums text-slate-900", tone)}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Cmp>
  );
}

function Bar({ pct, tone }: { pct: number | null; tone?: string }) {
  return (
    <span className="inline-block h-1.5 w-24 overflow-hidden rounded bg-slate-100 align-middle">
      <span className={cn("block h-full", tone ?? "bg-indigo-500")} style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
    </span>
  );
}

/* ---------------- row 146 ---------------- */
function Kpis({ onGo }: { onGo: (t: Tab) => void }) {
  const { data } = useQuery({ queryKey: ["kpis"], queryFn: api.getKpis });
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const k: KpiSnapshot = data;
  return (
    <div className="space-y-4" data-testid="kpis">
      <p className="text-xs text-muted-foreground">As of {new Date(k.asOf).toLocaleString()} · click a tile to open the report behind it.</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Tile label="Backlog (contracted, not yet invoiced)" value={fmtMoney(k.backlog.remainingValue)} hint={`${k.backlog.activeProjects} active projects · ${fmtMoney(k.backlog.contractedValue)} budgets, ${fmtMoney(k.backlog.invoicedSoFar)} invoiced`} onClick={() => onGo("profitability")} />
        <Tile label="Open tasks" value={String(k.backlog.openTasks)} hint={k.backlog.overdueTasks ? `${k.backlog.overdueTasks} overdue` : "none overdue"} tone={k.backlog.overdueTasks ? "text-red-700" : undefined} onClick={() => (window.location.href = "/overview")} />
        <Tile label="WIP (unbilled, approved)" value={fmtMoney(k.wip.total)} hint={`${k.wip.hours}h across ${k.wip.projects} projects${k.wip.awaitingHours ? ` · ${k.wip.awaitingHours}h awaiting approval` : ""}`} tone="text-indigo-700" onClick={() => onGo("wip")} />
        <Tile label="Receivables" value={fmtMoney(k.receivables.outstanding)} hint={`${fmtMoney(k.receivables.overdue)} overdue · ${fmtMoney(k.receivables.over90)} past 90 days`} tone={k.receivables.overdue ? "text-amber-700" : undefined} onClick={() => onGo("receivables")} />
        <Tile label="Billable utilization (this month)" value={k.utilization.billablePct == null ? "—" : `${k.utilization.billablePct}%`} hint={`${k.utilization.billableHours}h billable of ${k.utilization.available}h available · ${k.utilization.loggedPct ?? 0}% logged`} onClick={() => onGo("utilization")} />
        <Tile label="Pipeline" value={fmtMoney(k.pipeline.weighted)} hint={`weighted · ${k.pipeline.openDeals} open deals worth ${fmtMoney(k.pipeline.value)}`} onClick={() => (window.location.href = "/crm/deals")} />
        <Tile label="Revenue YTD" value={fmtMoney(k.profitability.revenueYtd)} hint={`margin ${fmtMoney(k.profitability.marginYtd)}${k.profitability.marginPct != null ? ` (${k.profitability.marginPct}%)` : ""}`} tone="text-emerald-700" onClick={() => onGo("profitability")} />
      </div>
    </div>
  );
}

/* ---------------- row 142 ---------------- */
function UtilizationTab({ from, to }: { from: string; to: string }) {
  const { data } = useQuery({ queryKey: ["utilization", from, to], queryFn: () => api.getUtilization(from, to) });
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const u: Utilization = data;
  const tone = (p: number | null) => (p == null ? "" : p >= 70 ? "text-emerald-700" : p >= 50 ? "text-slate-800" : "text-amber-700");
  return (
    <div className="space-y-4" data-testid="utilization">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Team billable utilization" value={u.team.billableUtilizationPct == null ? "—" : `${u.team.billableUtilizationPct}%`} hint={`${u.team.billable}h billable ÷ ${u.team.available}h available`} tone={tone(u.team.billableUtilizationPct)} />
        <Tile label="Logged utilization" value={u.team.loggedUtilizationPct == null ? "—" : `${u.team.loggedUtilizationPct}%`} hint={`${u.team.logged}h logged`} />
        <Tile label="Available hours" value={`${u.team.available}h`} hint={`${u.team.capacity}h capacity after holidays & leave`} />
        <Tile label="Period" value={`${fmtShortDate(u.from)} – ${fmtShortDate(u.to)}`} hint="from each person's working calendar" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Person</th>
              <th className="px-3 py-2 text-right font-medium">Available</th>
              <th className="px-3 py-2 text-right font-medium">Logged</th>
              <th className="px-3 py-2 text-right font-medium">Billable</th>
              <th className="px-3 py-2 text-right font-medium">Internal</th>
              <th className="px-3 py-2 text-left font-medium">Billable utilization</th>
              <th className="px-3 py-2 text-left font-medium">Logged</th>
            </tr>
          </thead>
          <tbody>
            {u.people.map((p) => (
              <FragmentRows key={p.userId}>
                <tr className="border-t border-border hover:bg-[#fbfbfa]">
                  <td className="px-3 py-2"><button onClick={() => setOpen(open === p.userId ? null : p.userId)} className="font-medium text-slate-900 hover:underline">{p.name}</button><span className="ml-1 text-xs text-muted-foreground">{p.role}</span>{(p.holidayHours > 0 || p.leaveHours > 0) && <span className="ml-1 text-[10px] text-muted-foreground">−{p.holidayHours + p.leaveHours}h off</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.available}h</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.loggedHours}h</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-900">{p.billableHours}h</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{p.internalHours}h</td>
                  <td className="px-3 py-2"><Bar pct={p.billableUtilizationPct} tone={p.billableUtilizationPct != null && p.billableUtilizationPct >= 70 ? "bg-emerald-500" : p.billableUtilizationPct != null && p.billableUtilizationPct < 50 ? "bg-amber-500" : undefined} /> <span className={cn("ml-2 tabular-nums", tone(p.billableUtilizationPct))}>{p.billableUtilizationPct == null ? "—" : `${p.billableUtilizationPct}%`}</span></td>
                  <td className="px-3 py-2"><Bar pct={p.loggedUtilizationPct} tone="bg-slate-400" /> <span className="ml-2 tabular-nums text-muted-foreground">{p.loggedUtilizationPct == null ? "—" : `${p.loggedUtilizationPct}%`}</span></td>
                </tr>
                {open === p.userId && (
                  <tr className="border-t border-border bg-[#fbfbfa]">
                    <td colSpan={7} className="px-3 py-2 text-xs">
                      {p.projects.length ? p.projects.map((pr) => <span key={pr.id} className="mr-3"><Link to="/projects/$projectId" params={{ projectId: pr.id }} className="text-indigo-700 hover:underline">{pr.name}</Link> {pr.hours}h ({pr.billableHours}h billable)</span>) : <span className="text-muted-foreground">No client hours in this period.</span>}
                    </td>
                  </tr>
                )}
              </FragmentRows>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/* ---------------- row 143 ---------------- */
function ProfitabilityTab({ from, to }: { from: string; to: string }) {
  const [all, setAll] = useState(true);
  const { data } = useQuery({ queryKey: ["profitability", all, from, to], queryFn: () => api.getProfitability(all ? undefined : { from, to }) });
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const p: Profitability = data;
  const t = p.totals;
  return (
    <div className="space-y-4" data-testid="profitability">
      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5 text-slate-700"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Whole project life (ignore dates)</label>
        <span className="text-muted-foreground">Revenue = issued invoices · labour = hours × cost rate on the day · expenses = approved, non-personal (freelancer invoices included)</span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="Revenue" value={fmtMoney(t.revenue)} hint={`${fmtMoney(t.collected)} collected`} />
        <Tile label="Labour cost" value={fmtMoney(t.labourCost)} hint={`${t.hours}h`} />
        <Tile label="Expenses" value={fmtMoney(t.expenses)} />
        <Tile label="Margin" value={fmtMoney(t.margin)} tone={t.margin < 0 ? "text-red-700" : "text-emerald-700"} />
        <Tile label="Margin %" value={t.marginPct == null ? "—" : `${t.marginPct}%`} />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Project</th>
              <th className="px-3 py-2 text-right font-medium">Revenue</th>
              <th className="px-3 py-2 text-right font-medium">Hours</th>
              <th className="px-3 py-2 text-right font-medium">Labour</th>
              <th className="px-3 py-2 text-right font-medium">Expenses</th>
              <th className="px-3 py-2 text-right font-medium">Margin</th>
              <th className="px-3 py-2 text-right font-medium">%</th>
              <th className="px-3 py-2 text-right font-medium">Eff. rate</th>
            </tr>
          </thead>
          <tbody>
            {p.projects.map((r) => (
              <tr key={r.id} className="border-t border-border hover:bg-[#fbfbfa]">
                <td className="px-3 py-2"><Link to="/projects/$projectId" params={{ projectId: r.id }} className="font-medium text-slate-900 hover:underline">{r.name}</Link>{r.client && <span className="ml-1 text-xs text-muted-foreground">· {r.client}</span>}{r.missingCostRates && <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-800" title="Some hours have no cost rate — set rate cards">no cost rate</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.revenue, r.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.hours}h</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.labourCost, r.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.expenses, r.currency)}{r.contractorCost > 0 && <span className="ml-1 text-[10px] text-muted-foreground">({fmtMoney(r.contractorCost, r.currency)} freelancers)</span>}</td>
                <td className={cn("px-3 py-2 text-right font-medium tabular-nums", r.margin < 0 ? "text-red-700" : "text-emerald-700")}>{fmtMoney(r.margin, r.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.marginPct == null ? "—" : `${r.marginPct}%`}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.effectiveRate == null ? "—" : `${fmtMoney(r.effectiveRate, r.currency)}/h`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- row 144 ---------------- */
function WipTab() {
  const [onlyApproved, setOnlyApproved] = useState(true);
  const { data } = useQuery({ queryKey: ["wip", onlyApproved], queryFn: () => api.getWip(onlyApproved) });
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const w: WipReport = data;
  return (
    <div className="space-y-4" data-testid="wip">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Unbilled work" value={fmtMoney(w.totals.total)} hint="next month's invoicing, at billing rates" tone="text-indigo-700" />
        <Tile label="Hours" value={`${w.totals.hours}h`} hint={fmtMoney(w.totals.hoursAmount)} />
        <Tile label="Expenses to re-bill" value={fmtMoney(w.totals.expensesAmount)} />
        <Tile label="Awaiting approval" value={`${w.totals.awaitingHours}h`} hint="not counted until the timesheet is approved" tone={w.totals.awaitingHours ? "text-amber-700" : undefined} />
      </div>
      <label className="flex items-center gap-1.5 text-xs text-slate-700"><input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} /> Only approved hours</label>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Project</th>
              <th className="px-3 py-2 text-right font-medium">Hours</th>
              <th className="px-3 py-2 text-right font-medium">Hours value</th>
              <th className="px-3 py-2 text-right font-medium">Awaiting</th>
              <th className="px-3 py-2 text-right font-medium">Expenses</th>
              <th className="px-3 py-2 text-right font-medium">WIP</th>
              <th className="w-28" />
            </tr>
          </thead>
          <tbody>
            {w.projects.map((r) => (
              <tr key={r.project.id} className="border-t border-border hover:bg-[#fbfbfa]">
                <td className="px-3 py-2"><Link to="/projects/$projectId" params={{ projectId: r.project.id }} className="font-medium text-slate-900 hover:underline">{r.project.name}</Link>{r.rateMissing && <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-800">no rate</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.hours}h</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.hoursAmount, r.project.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.awaitingHours ? `${r.awaitingHours}h` : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.expensesCount ? fmtMoney(r.expensesAmount, r.project.currency) : "—"}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-900">{fmtMoney(r.total, r.project.currency)}</td>
                <td className="px-2 text-right"><Link to="/projects/$projectId" params={{ projectId: r.project.id }} className="text-xs text-indigo-700 hover:underline">bill it →</Link></td>
              </tr>
            ))}
            {!w.projects.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing unbilled.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- row 145 ---------------- */
function ReceivablesTab() {
  const { data } = useQuery({ queryKey: ["receivables"], queryFn: () => api.getAgedReceivables() });
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const ar: AgedReceivables = data;
  const cols: { key: keyof AgedReceivables["totals"]; label: string; tone?: string }[] = [
    { key: "current", label: "Not yet due" },
    { key: "d1_30", label: "1–30 days" },
    { key: "d31_60", label: "31–60", tone: "text-amber-700" },
    { key: "d61_90", label: "61–90", tone: "text-amber-800" },
    { key: "d90plus", label: "90+", tone: "text-red-700" },
  ];
  return (
    <div className="space-y-4" data-testid="receivables">
      <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
        <Tile label="Outstanding" value={fmtMoney(ar.totals.total)} hint={`${fmtMoney(ar.overdue)} overdue`} />
        {cols.map((c) => <Tile key={c.key} label={c.label} value={fmtMoney(ar.totals[c.key])} tone={ar.totals[c.key] > 0 ? c.tone : undefined} />)}
      </div>
      <p className="text-xs text-muted-foreground">Sorted by who is furthest behind — chase the top rows first. Click a client to see the invoices.</p>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Client</th>
              {cols.map((c) => <th key={c.key} className="px-3 py-2 text-right font-medium">{c.label}</th>)}
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {ar.clients.map((c) => {
              const key = c.id ?? c.name;
              return (
                <FragmentRows key={key}>
                  <tr className="border-t border-border hover:bg-[#fbfbfa]">
                    <td className="px-3 py-2"><button onClick={() => setOpen(open === key ? null : key)} className="font-medium text-slate-900 hover:underline">{c.name}</button>{c.id && <Link to="/crm/companies/$companyId" params={{ companyId: c.id }} className="ml-2 text-[10px] text-indigo-700 hover:underline">open ↗</Link>}</td>
                    {cols.map((col) => <td key={col.key} className={cn("px-3 py-2 text-right tabular-nums", c.buckets[col.key] > 0 ? col.tone ?? "text-slate-800" : "text-muted-foreground")}>{c.buckets[col.key] > 0 ? fmtMoney(c.buckets[col.key]) : "—"}</td>)}
                    <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-900">{fmtMoney(c.buckets.total)}</td>
                  </tr>
                  {open === key && (
                    <tr className="border-t border-border bg-[#fbfbfa]">
                      <td colSpan={7} className="px-3 py-2">
                        <ul className="space-y-0.5 text-xs">
                          {c.invoices.map((i) => (
                            <li key={i.id} className="flex items-center gap-3">
                              <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: i.id }} className="w-24 font-medium text-indigo-700 hover:underline">{i.number}</Link>
                              <span className="min-w-0 flex-1 truncate text-slate-700">{i.title}</span>
                              <span className={cn(i.daysOverdue > 0 ? "text-red-700" : "text-muted-foreground")}>{i.dueDate ? (i.daysOverdue > 0 ? `${i.daysOverdue}d overdue` : `due ${fmtShortDate(i.dueDate)}`) : "no due date"}</span>
                              <span className="w-24 text-right tabular-nums text-slate-900">{fmtMoney(i.balance, i.currency)}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </FragmentRows>
              );
            })}
            {!ar.clients.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing outstanding.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
