import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type PnlBasis, type PnlGranularity, type PnlReport } from "../lib/api.js";
import { fmtMoney, isoDay } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { cn } from "../lib/utils.js";

/** Two fixed series hues (validated categorical pair): income = blue, expenses = orange. */
const INCOME = "#2a78d6";
const EXPENSE = "#eb6834";

type Preset = "ytd" | "last12" | "lastyear" | "quarter" | "custom";

function presetRange(p: Preset): { from: string; to: string; granularity: PnlGranularity } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (p) {
    case "last12": {
      const from = new Date(Date.UTC(y, m - 11, 1));
      return { from: isoDay(from), to: isoDay(new Date(Date.UTC(y, m + 1, 0))), granularity: "month" };
    }
    case "lastyear":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, granularity: "month" };
    case "quarter": {
      const qs = Math.floor(m / 3) * 3;
      return { from: isoDay(new Date(Date.UTC(y, qs, 1))), to: isoDay(new Date(Date.UTC(y, qs + 3, 0))), granularity: "month" };
    }
    default:
      return { from: `${y}-01-01`, to: `${y}-12-31`, granularity: "month" };
  }
}

/**
 * Row 161: where the business stands. Income (paid, or issued on accrual) minus
 * expenses by period and by category, per client and per project, exportable.
 */
export function PnlPage() {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const [preset, setPreset] = useState<Preset>("ytd");
  const [basis, setBasis] = useState<PnlBasis>("cash");
  const [range, setRange] = useState(() => presetRange("ytd"));
  const apply = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
  };
  const { data, isLoading, isError } = useQuery({ queryKey: ["pnl", range, basis], queryFn: () => api.getPnl({ ...range, basis }), enabled: admin });
  const exportCsv = useMutation({ mutationFn: () => api.downloadPnlCsv({ ...range, basis }) });

  if (!admin) return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">Profit &amp; Loss is visible to owners and admins.</div>;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Profit &amp; Loss</h1>
        <div className="flex gap-1 rounded-md bg-muted p-1 text-xs font-medium">
          {([["ytd", "This year"], ["quarter", "This quarter"], ["last12", "Last 12 months"], ["lastyear", "Last year"], ["custom", "Custom"]] as [Preset, string][]).map(([k, label]) => (
            <button key={k} onClick={() => apply(k)} className={cn("rounded px-2 py-1 transition", preset === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>{label}</button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-1 text-xs">
            <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="rounded border border-border px-1.5 py-1" />
            <span className="text-muted-foreground">to</span>
            <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="rounded border border-border px-1.5 py-1" />
          </div>
        )}
        <select value={range.granularity} onChange={(e) => setRange((r) => ({ ...r, granularity: e.target.value as PnlGranularity }))} className="rounded-md border border-border px-2 py-1 text-xs">
          <option value="month">By month</option>
          <option value="quarter">By quarter</option>
          <option value="year">By year</option>
        </select>
        <div className="flex gap-1 rounded-md bg-muted p-1 text-xs font-medium" title="Cash: income when the money arrived. Accrual: income when the invoice was issued.">
          {(["cash", "accrual"] as PnlBasis[]).map((b) => (
            <button key={b} onClick={() => setBasis(b)} className={cn("rounded px-2 py-1 capitalize transition", basis === b ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>{b}</button>
          ))}
        </div>
        <button onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending} className="ml-auto rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-muted disabled:opacity-50">{exportCsv.isPending ? "Exporting…" : "Export CSV"}</button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && <p className="text-sm text-muted-foreground">Crunching…</p>}
        {isError && <p className="text-sm text-red-700">Could not load the report.</p>}
        {data && (
          <div className="mx-auto max-w-6xl space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label={basis === "cash" ? "Income received" : "Income invoiced"} value={fmtMoney(data.totals.income, data.currency)} hint={`${data.totals.invoices} invoice${data.totals.invoices === 1 ? "" : "s"}`} swatch={INCOME} />
              <Tile label="Expenses" value={fmtMoney(data.totals.expenses, data.currency)} hint={`${data.totals.expenseCount} entries, net of refunds`} swatch={EXPENSE} />
              <Tile label="Net profit" value={fmtMoney(data.totals.net, data.currency)} tone={data.totals.net < 0 ? "text-red-700" : "text-emerald-700"} hint={data.totals.net < 0 ? "spending more than earning" : "kept after costs"} />
              <Tile label="Margin" value={data.totals.margin == null ? "—" : `${data.totals.margin}%`} hint="net ÷ income" />
            </div>

            <section className="rounded-lg border border-border bg-white p-4">
              <div className="mb-3 flex items-center gap-4">
                <h2 className="text-sm font-semibold text-slate-800">Income vs expenses</h2>
                <span className="flex items-center gap-1.5 text-xs text-slate-600"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: INCOME }} /> Income</span>
                <span className="flex items-center gap-1.5 text-xs text-slate-600"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: EXPENSE }} /> Expenses</span>
                <span className="ml-auto text-xs text-muted-foreground">{data.from} → {data.to}</span>
              </div>
              <BarChart buckets={data.buckets} currency={data.currency} />
            </section>

            <div className="grid gap-5 lg:grid-cols-2">
              <section className="rounded-lg border border-border bg-white">
                <div className="border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">By period</h2></div>
                <table className="w-full text-sm">
                  <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                    <tr><th className="px-4 py-2 text-left font-medium">Period</th><th className="px-3 py-2 text-right font-medium">Income</th><th className="px-3 py-2 text-right font-medium">Expenses</th><th className="px-4 py-2 text-right font-medium">Net</th></tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((b) => (
                      <tr key={b.key} className="border-t border-border">
                        <td className="px-4 py-1.5 text-slate-700">{b.label}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{b.income ? fmtMoney(b.income, data.currency) : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{b.expenses ? fmtMoney(b.expenses, data.currency) : <span className="text-slate-300">—</span>}</td>
                        <td className={cn("px-4 py-1.5 text-right tabular-nums font-medium", b.net < 0 ? "text-red-700" : b.net > 0 ? "text-emerald-700" : "text-slate-300")}>{b.net ? fmtMoney(b.net, data.currency) : "—"}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border bg-[#fbfbfa] font-semibold">
                      <td className="px-4 py-2 text-slate-900">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(data.totals.income, data.currency)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(data.totals.expenses, data.currency)}</td>
                      <td className={cn("px-4 py-2 text-right tabular-nums", data.totals.net < 0 ? "text-red-700" : "text-emerald-700")}>{fmtMoney(data.totals.net, data.currency)}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              <section className="rounded-lg border border-border bg-white">
                <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-slate-800">Expenses by category</h2>
                  <Link to="/finance/expenses" className="ml-auto text-xs text-indigo-600 hover:underline">Open expenses</Link>
                </div>
                {data.categories.length ? (
                  <ul className="divide-y divide-border">
                    {data.categories.map((c) => (
                      <li key={c.category} className="px-4 py-1.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className={cn("min-w-0 flex-1 truncate", c.category === "Uncategorised" ? "text-amber-700" : "text-slate-700")}>{c.category}</span>
                          <span className="tabular-nums text-slate-800">{fmtMoney(c.amount, data.currency)}</span>
                          <span className="w-10 text-right tabular-nums text-muted-foreground">{c.share}%</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-sm bg-slate-100"><div className="h-1.5 rounded-sm" style={{ width: `${Math.max(0, Math.min(100, c.share))}%`, background: EXPENSE }} /></div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-4 py-5 text-xs text-muted-foreground">No expenses in this range.</p>
                )}
              </section>

              <section className="rounded-lg border border-border bg-white">
                <div className="border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">Income by client</h2></div>
                {data.clients.length ? (
                  <ul className="divide-y divide-border">
                    {data.clients.map((c) => (
                      <li key={c.id ?? "none"} className="px-4 py-1.5 text-xs">
                        <div className="flex items-center gap-2">
                          {c.id ? <Link to="/crm/companies/$companyId" params={{ companyId: c.id }} className="min-w-0 flex-1 truncate text-slate-700 hover:text-indigo-700">{c.name}</Link> : <span className="min-w-0 flex-1 truncate text-slate-500">{c.name}</span>}
                          <span className="tabular-nums text-slate-800">{fmtMoney(c.amount, data.currency)}</span>
                          <span className="w-10 text-right tabular-nums text-muted-foreground">{c.share}%</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-sm bg-slate-100"><div className="h-1.5 rounded-sm" style={{ width: `${Math.max(0, Math.min(100, c.share))}%`, background: INCOME }} /></div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-4 py-5 text-xs text-muted-foreground">No income in this range.</p>
                )}
              </section>

              <section className="rounded-lg border border-border bg-white">
                <div className="border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">Project margins</h2></div>
                {data.projects.length ? (
                  <table className="w-full text-xs">
                    <thead className="bg-[#fbfbfa] text-muted-foreground">
                      <tr><th className="px-4 py-2 text-left font-medium">Project</th><th className="px-2 py-2 text-right font-medium">Income</th><th className="px-2 py-2 text-right font-medium">Expenses</th><th className="px-4 py-2 text-right font-medium">Margin</th></tr>
                    </thead>
                    <tbody>
                      {data.projects.map((p) => (
                        <tr key={p.id ?? "none"} className="border-t border-border">
                          <td className="px-4 py-1.5">{p.id ? <Link to="/projects/$projectId" params={{ projectId: p.id }} className="text-slate-700 hover:text-indigo-700">{p.name}</Link> : <span className="text-slate-500">{p.name}</span>}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{fmtMoney(p.income, data.currency)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{fmtMoney(p.expenses, data.currency)}</td>
                          <td className={cn("px-4 py-1.5 text-right tabular-nums font-medium", p.margin < 0 ? "text-red-700" : "text-emerald-700")}>{fmtMoney(p.margin, data.currency)}{p.marginPct != null && <span className="ml-1 font-normal text-muted-foreground">({p.marginPct}%)</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="px-4 py-5 text-xs text-muted-foreground">Nothing tied to a project in this range.</p>
                )}
              </section>
            </div>

            {data.vendors.length > 0 && (
              <section className="rounded-lg border border-border bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-800">Top vendors</h2>
                <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                  {data.vendors.map((v) => (
                    <li key={v.vendor} className="rounded-full border border-border px-2.5 py-1 text-slate-700">{v.vendor} <span className="tabular-nums text-muted-foreground">{fmtMoney(v.amount, data.currency)}</span></li>
                  ))}
                </ul>
              </section>
            )}
            <p className="text-[11px] text-muted-foreground">
              {basis === "cash" ? "Cash basis: income counts when a payment is recorded on an invoice." : "Accrual basis: income counts when an invoice is issued (sent), whether or not it has been paid."} Expenses exclude rows marked personal; refunds are subtracted. Estimates only — your accountant has the final word.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, hint, tone, swatch }: { label: string; value: string; hint?: string; tone?: string; swatch?: string }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{swatch && <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: swatch }} />}{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums text-slate-900", tone)}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Grouped bars per period, one shared axis, hover tooltip, direct labels on the largest values only. */
function BarChart({ buckets, currency }: { buckets: PnlReport["buckets"]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 960;
  const H = 240;
  const padL = 56;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const max = useMemo(() => Math.max(1, ...buckets.flatMap((b) => [b.income, b.expenses])), [buckets]);
  const niceMax = niceCeil(max);
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = Math.max(1, buckets.length);
  const slot = innerW / n;
  const gap = 2;
  const barW = Math.max(3, Math.min(28, (slot - 14) / 2 - gap / 2));
  const y = (v: number) => padT + innerH - (Math.max(0, v) / niceMax) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * niceMax);
  const top = [...buckets].sort((a, b) => Math.max(b.income, b.expenses) - Math.max(a.income, a.expenses)).slice(0, 2);
  if (!buckets.some((b) => b.income || b.expenses)) return <p className="py-8 text-center text-xs text-muted-foreground">No money moved in this range yet.</p>;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-60 w-full" role="img" aria-label="Income and expenses per period">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={padL - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#64748b">{short(t)}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x0 = padL + i * slot + (slot - (barW * 2 + gap)) / 2;
          const yi = y(b.income);
          const ye = y(b.expenses);
          const base = padT + innerH;
          const labelTop = top.includes(b);
          return (
            <g key={b.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill={hover === i ? "#f1f5f9" : "transparent"} />
              {b.income > 0 && <path d={roundedTop(x0, yi, barW, base - yi)} fill={INCOME} />}
              {b.expenses > 0 && <path d={roundedTop(x0 + barW + gap, ye, barW, base - ye)} fill={EXPENSE} />}
              {labelTop && b.income > 0 && <text x={x0 + barW / 2} y={yi - 4} textAnchor="middle" fontSize={10} fill="#334155">{short(b.income)}</text>}
              {labelTop && b.expenses > 0 && <text x={x0 + barW + gap + barW / 2} y={ye - 4} textAnchor="middle" fontSize={10} fill="#334155">{short(b.expenses)}</text>}
              <text x={padL + i * slot + slot / 2} y={H - 10} textAnchor="middle" fontSize={10} fill="#64748b">{b.label.replace(/ \d{4}$/, buckets.length > 12 ? "" : "")}</text>
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={padT + innerH} y2={padT + innerH} stroke="#cbd5e1" strokeWidth={1} />
      </svg>
      {hover != null && buckets[hover] && (
        <div className="pointer-events-none absolute top-2 rounded-md border border-border bg-white px-2.5 py-1.5 text-xs shadow-md" style={{ left: `${Math.min(88, (hover / n) * 100 + 2)}%` }}>
          <p className="font-medium text-slate-800">{buckets[hover].label}</p>
          <p className="text-slate-600"><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: INCOME }} />Income {fmtMoney(buckets[hover].income, currency)}</p>
          <p className="text-slate-600"><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: EXPENSE }} />Expenses {fmtMoney(buckets[hover].expenses, currency)}</p>
          <p className={cn("font-medium", buckets[hover].net < 0 ? "text-red-700" : "text-emerald-700")}>Net {fmtMoney(buckets[hover].net, currency)}</p>
        </div>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
function niceCeil(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p;
}
function short(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(v)}`;
}
