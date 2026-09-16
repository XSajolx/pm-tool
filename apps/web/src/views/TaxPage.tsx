import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TaxQuarter, type TaxSettings, type TaxYear } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

const STATUS: Record<TaxQuarter["status"], { label: string; cls: string }> = {
  future: { label: "Not started", cls: "bg-slate-100 text-slate-500 border-slate-200" },
  in_progress: { label: "In progress", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  upcoming: { label: "Upcoming", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  due_soon: { label: "Due soon", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  overdue: { label: "Overdue", cls: "bg-red-50 text-red-700 border-red-200" },
  paid: { label: "Paid", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  none: { label: "Nothing due", cls: "bg-slate-100 text-slate-500 border-slate-200" },
};

/**
 * Row 163: what to set aside for tax each quarter, when it is due, what has
 * been paid — computed from the cash-basis P&L with the rates you set.
 */
export function TaxPage() {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [settings, setSettings] = useState(false);
  const [paying, setPaying] = useState<TaxQuarter | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["tax", year], queryFn: () => api.getTaxYear(year), enabled: admin });
  const refresh = () => qc.invalidateQueries({ queryKey: ["tax"] });
  const unpay = useMutation({ mutationFn: (id: string) => api.deleteTaxPayment(id), onSuccess: refresh });

  if (!admin) return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">Tax estimates are for owners and admins.</div>;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Quarterly taxes</h1>
        <div className="flex items-center gap-1 text-xs">
          <button onClick={() => setYear((y) => y - 1)} className="rounded border border-border px-2 py-0.5 hover:bg-muted">‹</button>
          <span className="w-12 text-center font-medium text-slate-800">{year}</span>
          <button onClick={() => setYear((y) => y + 1)} className="rounded border border-border px-2 py-0.5 hover:bg-muted">›</button>
        </div>
        {data && <span className="text-xs text-muted-foreground">{data.settings.jurisdictions.map((j) => `${j.label} ${j.ratePct}%`).join(" + ")} on {data.settings.basis === "net" ? "net profit" : "gross income"}{data.settings.deductionPct ? ` after ${data.settings.deductionPct}% deduction` : ""}</span>}
        <button onClick={() => setSettings(true)} className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Rates & dates</button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading || !data ? (
          <p className="text-sm text-muted-foreground">Crunching…</p>
        ) : (
          <div className="mx-auto max-w-6xl space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label={`Net profit ${year}`} value={fmtMoney(data.ytd.net)} hint={`income ${fmtMoney(data.ytd.income)} − expenses ${fmtMoney(data.ytd.expenses)}`} />
              <Tile label="Estimated tax" value={fmtMoney(data.ytd.estimate)} hint={`≈ ${data.ytd.effectiveRatePct}% of taxable`} />
              <Tile label="Paid so far" value={fmtMoney(data.ytd.paid)} tone="text-emerald-700" />
              <Tile label="Still to pay" value={fmtMoney(data.ytd.remaining)} tone={data.ytd.remaining > 0 ? "text-amber-700" : "text-emerald-700"} hint={data.taxBucketBalance != null ? `Profit First tax bucket holds ${fmtMoney(data.taxBucketBalance)}` : undefined} />
            </div>

            {data.nextDue && (
              <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm", data.nextDue.status === "overdue" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800")}>
                <span className="font-medium">{data.nextDue.label} payment {data.nextDue.status === "overdue" ? "was due" : "is due"} {fmtShortDate(data.nextDue.dueDate)}{data.nextDue.daysToDue >= 0 ? ` — in ${data.nextDue.daysToDue} day${data.nextDue.daysToDue === 1 ? "" : "s"}` : ""}.</span>
                <span>{fmtMoney(data.nextDue.remaining)} still to pay.</span>
                <button onClick={() => setPaying(data.nextDue)} className="ml-auto rounded-md bg-white px-3 py-1 text-xs font-medium text-slate-800 shadow-sm hover:bg-slate-50">Record payment</button>
              </div>
            )}
            {data.projection && (
              <p className="text-xs text-muted-foreground">Full-year projection at this pace: net profit ≈ <b className="text-slate-700">{fmtMoney(data.projection.net)}</b>, tax ≈ <b className="text-slate-700">{fmtMoney(data.projection.estimate)}</b>.</p>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              {data.quarters.map((q) => {
                const st = STATUS[q.status];
                return (
                  <section key={q.q} className={cn("rounded-lg border bg-white", q.status === "overdue" ? "border-red-200" : q.status === "due_soon" ? "border-amber-200" : "border-border")}>
                    <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
                      <h2 className="text-sm font-semibold text-slate-800">{q.label}</h2>
                      <span className="text-xs text-muted-foreground">{fmtShortDate(q.from)} – {fmtShortDate(q.to)}</span>
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
                      <span className="ml-auto text-xs text-muted-foreground">due {fmtShortDate(q.dueDate)}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 px-4 py-3 text-xs">
                      <div><p className="text-muted-foreground">Income</p><p className="tabular-nums text-slate-800">{fmtMoney(q.income)}</p></div>
                      <div><p className="text-muted-foreground">Expenses</p><p className="tabular-nums text-slate-800">{fmtMoney(q.expenses)}</p></div>
                      <div><p className="text-muted-foreground">{data.settings.basis === "net" ? "Net profit" : "Taxable income"}</p><p className={cn("tabular-nums font-medium", q.net < 0 ? "text-red-700" : "text-slate-900")}>{fmtMoney(data.settings.basis === "net" ? q.net : q.income)}</p></div>
                    </div>
                    <ul className="border-t border-border px-4 py-2 text-xs">
                      {q.byJurisdiction.map((j) => (
                        <li key={j.key} className="flex justify-between py-0.5 text-slate-600"><span>{j.label} <span className="text-muted-foreground">{j.ratePct}%</span></span><span className="tabular-nums">{fmtMoney(j.amount)}</span></li>
                      ))}
                      <li className="mt-1 flex justify-between border-t border-border pt-1 font-semibold text-slate-900"><span>Estimated</span><span className="tabular-nums">{fmtMoney(q.estimate)}</span></li>
                      {q.paid > 0 && <li className="flex justify-between text-emerald-700"><span>Paid</span><span className="tabular-nums">−{fmtMoney(q.paid)}</span></li>}
                      {q.paid > 0 && <li className="flex justify-between font-semibold text-slate-900"><span>Remaining</span><span className="tabular-nums">{fmtMoney(q.remaining)}</span></li>}
                    </ul>
                    {q.payments.length > 0 && (
                      <ul className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
                        {q.payments.map((p) => (
                          <li key={p.id} className="flex items-center gap-2 py-0.5">
                            <span>{fmtShortDate(p.paidAt)}</span>
                            <span className="text-slate-700">{fmtMoney(p.amount)}</span>
                            {p.jurisdiction && <span>{data.settings.jurisdictions.find((j) => j.key === p.jurisdiction)?.label ?? p.jurisdiction}</span>}
                            {p.reference && <span>· {p.reference}</span>}
                            <button onClick={() => unpay.mutate(p.id)} className="ml-auto text-slate-300 hover:text-red-600" title="Remove">✕</button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="border-t border-border px-4 py-2">
                      <button onClick={() => setPaying(q)} disabled={q.status === "future"} className="rounded-md border border-border px-3 py-1 text-xs font-medium text-slate-700 hover:bg-muted disabled:opacity-40">Record payment</button>
                    </div>
                  </section>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Estimates only: cash-basis income minus business expenses (personal rows excluded) for each calendar quarter, times the rates you set. Your accountant files the return; use this to know what to set aside. Change rates and due dates under “Rates &amp; dates”. See <Link to="/finance/pnl" className="text-indigo-600 hover:underline">Profit &amp; Loss</Link> for the underlying numbers{data.taxBucketBalance != null ? " and " : "."}{data.taxBucketBalance != null && <Link to="/finance/profit-first" className="text-indigo-600 hover:underline">Profit First</Link>}{data.taxBucketBalance != null ? " for the tax bucket." : ""}
            </p>
          </div>
        )}
      </div>

      {settings && data && <SettingsDialog cfg={data.settings} onClose={() => setSettings(false)} onSaved={() => { setSettings(false); refresh(); }} />}
      {paying && data && <PayDialog year={data.year} q={paying} jurisdictions={data.settings.jurisdictions} onClose={() => setPaying(null)} onDone={() => { setPaying(null); refresh(); }} />}
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums text-slate-900", tone)}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SettingsDialog({ cfg, onClose, onSaved }: { cfg: TaxSettings; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const [rows, setRows] = useState(cfg.jurisdictions.map((j) => ({ ...j, ratePct: String(j.ratePct) })));
  const [basis, setBasis] = useState(cfg.basis);
  const [deduction, setDeduction] = useState(String(cfg.deductionPct));
  const [days, setDays] = useState(String(cfg.reminderDaysBefore));
  const [due, setDue] = useState(cfg.dueDates.map((d) => ({ ...d })));
  const [enabled, setEnabled] = useState(cfg.enabled);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRows(cfg.jurisdictions.map((j) => ({ ...j, ratePct: String(j.ratePct) }))), [cfg]);
  const save = useMutation({
    mutationFn: () => api.updateTaxSettings({ jurisdictions: rows.filter((r) => r.label.trim()).map((r) => ({ key: r.key, label: r.label, ratePct: Number(r.ratePct) || 0 })), basis, deductionPct: Number(deduction) || 0, reminderDaysBefore: Number(days) || 0, dueDates: due, enabled }),
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  const total = rows.reduce((a, r) => a + (Number(r.ratePct) || 0), 0);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[600px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Tax rates &amp; due dates</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Ask your accountant for the rates that fit you. Everything here is an estimate.</p>
        <table className="mt-4 w-full text-sm">
          <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-left font-medium">Jurisdiction / tax</th><th className="py-1 text-right font-medium">Rate %</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-1.5"><input value={r.label} onChange={(e) => setRows((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="w-full rounded border border-transparent bg-transparent px-1 hover:border-border focus:border-indigo-400" placeholder="Federal income tax" /></td>
                <td className="py-1.5 text-right"><input type="number" min="0" max="100" step="0.1" value={r.ratePct} onChange={(e) => setRows((l) => l.map((x, j) => (j === i ? { ...x, ratePct: e.target.value } : x)))} className="w-20 rounded border border-border px-2 py-1 text-right tabular-nums" /></td>
                <td className="py-1.5 pl-2 text-right"><button type="button" onClick={() => setRows((l) => l.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">✕</button></td>
              </tr>
            ))}
            <tr className="border-t border-border text-xs"><td className="py-1.5 text-muted-foreground">Combined</td><td className="py-1.5 text-right tabular-nums font-medium text-slate-800">{Math.round(total * 100) / 100}%</td><td /></tr>
          </tbody>
        </table>
        <button type="button" onClick={() => setRows((l) => [...l, { key: "", label: "", ratePct: "0" }])} className="mt-2 text-xs text-indigo-600 hover:underline">+ Add a tax</button>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <CrmField label="Apply rates to">
            <select value={basis} onChange={(e) => setBasis(e.target.value as "net" | "income")} className={input}><option value="net">Net profit</option><option value="income">Gross income</option></select>
          </CrmField>
          <CrmField label="Deduction before tax (%)"><input type="number" min="0" max="100" step="0.5" value={deduction} onChange={(e) => setDeduction(e.target.value)} className={input} /></CrmField>
          <CrmField label="Remind me (days before)"><input type="number" min="0" max="90" value={days} onChange={(e) => setDays(e.target.value)} className={input} /></CrmField>
        </div>
        <p className="mt-4 text-xs font-medium text-slate-700">Filing due dates</p>
        <div className="mt-1 grid grid-cols-4 gap-2">
          {due.map((d, i) => (
            <div key={d.q} className="rounded-md border border-border p-2 text-xs">
              <p className="mb-1 text-muted-foreground">Q{d.q}</p>
              <div className="flex gap-1">
                <select value={d.month} onChange={(e) => setDue((l) => l.map((x, j) => (j === i ? { ...x, month: Number(e.target.value) } : x)))} className="flex-1 rounded border border-border px-1 py-0.5">{months.map((m, k) => <option key={m} value={k + 1}>{m}</option>)}</select>
                <input type="number" min="1" max="31" value={d.day} onChange={(e) => setDue((l) => l.map((x, j) => (j === i ? { ...x, day: Number(e.target.value) } : x)))} className="w-12 rounded border border-border px-1 py-0.5 text-right" />
              </div>
            </div>
          ))}
        </div>
        <label className="mt-4 flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Send inbox reminders before each due date (and once if it passes unpaid)</label>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save</button>
        </div>
      </div>
    </>
  );
}

function PayDialog({ year, q, jurisdictions, onClose, onDone }: { year: number; q: TaxQuarter; jurisdictions: TaxSettings["jurisdictions"]; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [amount, setAmount] = useState(String(q.remaining || q.estimate));
  const [jurisdiction, setJurisdiction] = useState("");
  const [paidAt, setPaidAt] = useState(isoDay(new Date()));
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pay = useMutation({ mutationFn: () => api.recordTaxPayment({ year, quarter: q.q, jurisdiction: jurisdiction || null, amount: Number(amount), paidAt: new Date(paidAt).toISOString(), reference: reference || null }), onSuccess: onDone, onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")) });
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Record {q.label} tax payment</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Estimate {fmtMoney(q.estimate)}{q.paid ? `, paid ${fmtMoney(q.paid)}` : ""} — remaining {fmtMoney(q.remaining)}.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Amount"><input autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={input} /></CrmField>
          <CrmField label="Paid on"><input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className={input} /></CrmField>
          <CrmField label="Which tax">
            <select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} className={input}><option value="">Combined</option>{jurisdictions.map((j) => <option key={j.key} value={j.key}>{j.label}</option>)}</select>
          </CrmField>
          <CrmField label="Reference"><input value={reference} onChange={(e) => setReference(e.target.value)} className={input} placeholder="Confirmation no." /></CrmField>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => pay.mutate()} disabled={!(Number(amount) > 0) || pay.isPending} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">Record</button>
        </div>
      </div>
    </>
  );
}
