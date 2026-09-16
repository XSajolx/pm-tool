import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ProfitBucket, type ProfitFirstOverview } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

/** One fixed hue per bucket (identity), never reassigned. */
const BUCKET_COLOR: Record<ProfitBucket, string> = { profit: "#1baf7a", owner_pay: "#2a78d6", tax: "#eda100", opex: "#eb6834" };
const BUCKET_HINT: Record<ProfitBucket, string> = {
  profit: "Set aside first. Distribute a slice to the owner each quarter; the rest stays as a cushion.",
  owner_pay: "What the owner takes home. Pay yourself from here on a fixed rhythm.",
  tax: "Never touched except to pay the tax bill.",
  opex: "Everything else the business spends. If it runs out, costs are too high.",
};

/**
 * Row 162: Profit First. Income is split into four buckets the moment it is
 * recorded; this page shows the balances, what still has to be moved to the
 * bank, and the history — and holds the percentages.
 */
export function ProfitFirstPage() {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["profit-first"], queryFn: api.getProfitFirst, enabled: admin });
  const refresh = () => qc.invalidateQueries({ queryKey: ["profit-first"] });
  const [settings, setSettings] = useState(false);
  const [moving, setMoving] = useState<{ bucket: ProfitBucket; kind: "distribution" | "adjustment" } | null>(null);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError((e as Error).message.replace(/^API \d+: /, ""));
  const enable = useMutation({ mutationFn: (enabled: boolean) => api.updateProfitFirst({ enabled }), onSuccess: () => { setError(null); refresh(); }, onError: fail });
  const backfill = useMutation({ mutationFn: api.backfillProfitFirst, onSuccess: () => { setError(null); refresh(); }, onError: fail });
  const transfer = useMutation({ mutationFn: ({ id, transferred }: { id: string; transferred: boolean }) => api.setProfitAllocationTransferred(id, transferred), onSuccess: refresh, onError: fail });
  const transferAll = useMutation({ mutationFn: api.transferAllProfitAllocations, onSuccess: refresh, onError: fail });
  const removeMove = useMutation({ mutationFn: (id: string) => api.deleteProfitMovement(id), onSuccess: refresh, onError: fail });
  const removeAlloc = useMutation({ mutationFn: (id: string) => api.deleteProfitAllocation(id), onSuccess: refresh, onError: fail });

  if (!admin) return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">Profit First is for owners and admins.</div>;
  if (isLoading || !data) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  const cfg = data.config;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Profit First</h1>
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => enable.mutate(e.target.checked)} />
          {cfg.enabled ? `On since ${cfg.startedAt ?? "today"} — every recorded payment is split automatically` : "Off — turn on to start splitting income"}
        </label>
        <div className="ml-auto flex items-center gap-2">
          {cfg.enabled && data.unallocated.count > 0 && (
            <button onClick={() => backfill.mutate()} disabled={backfill.isPending} className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100">
              Split {data.unallocated.count} earlier payment{data.unallocated.count === 1 ? "" : "s"} ({fmtMoney(data.unallocated.amount)})
            </button>
          )}
          {cfg.enabled && <button onClick={() => setManual(true)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-muted">Split other income</button>}
          <button onClick={() => setSettings(true)} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Percentages</button>
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700"><span>{error}</span><button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-700">✕</button></div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {data.buckets.map((b) => (
              <div key={b.key} className="rounded-lg border border-border bg-white p-4">
                <div className="flex items-center gap-2">
                  <i className="inline-block h-3 w-3 rounded-sm" style={{ background: BUCKET_COLOR[b.key] }} />
                  <p className="text-sm font-semibold text-slate-800">{b.label}</p>
                  <span className="ml-auto text-xs text-muted-foreground" title={`Target ${b.targetPct}%`}>{b.currentPct}%{b.currentPct !== b.targetPct ? <span className="text-slate-400"> → {b.targetPct}%</span> : null}</span>
                </div>
                <p className={cn("mt-2 text-2xl font-semibold tabular-nums", b.balance < 0 ? "text-red-700" : "text-slate-900")}>{fmtMoney(b.balance)}</p>
                <p className="text-[11px] text-muted-foreground">allocated {fmtMoney(b.allocated)}{b.distributed ? ` · taken out ${fmtMoney(b.distributed)}` : ""}</p>
                {b.untransferred > 0 && <p className="mt-1 text-[11px] text-amber-700">{fmtMoney(b.untransferred)} not yet moved to the bank</p>}
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{BUCKET_HINT[b.key]}</p>
                <div className="mt-3 flex gap-1">
                  <button onClick={() => setMoving({ bucket: b.key, kind: "distribution" })} className="rounded border border-border px-2 py-0.5 text-[11px] text-slate-700 hover:bg-muted">{b.key === "tax" ? "Pay tax" : b.key === "owner_pay" ? "Pay owner" : b.key === "profit" ? "Distribute" : "Spend"}</button>
                  <button onClick={() => setMoving({ bucket: b.key, kind: "adjustment" })} className="rounded border border-border px-2 py-0.5 text-[11px] text-slate-500 hover:bg-muted">Adjust</button>
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <Stat label="Income split so far" value={fmtMoney(data.totals.allocated)} />
            <Stat label="Sitting in buckets" value={fmtMoney(data.totals.balance)} />
            <Stat label="Still to move to the bank" value={fmtMoney(data.totals.untransferred)} tone={data.totals.untransferred > 0 ? "text-amber-700" : "text-emerald-700"} action={data.totals.untransferred > 0 ? <button onClick={() => transferAll.mutate()} className="text-[11px] text-indigo-600 hover:underline">Mark all transferred</button> : undefined} />
          </div>

          <SplitBar buckets={data.buckets} />

          <section className="rounded-lg border border-border bg-white">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-800">Allocations</h2>
              <span className="text-xs text-muted-foreground">one row per payment received · tick when you have moved the money into the bucket accounts</span>
            </div>
            {data.allocations.length ? (
              <table className="w-full text-xs">
                <thead className="bg-[#fbfbfa] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-2 py-2 text-left font-medium">Source</th>
                    <th className="px-2 py-2 text-right font-medium">Income</th>
                    {data.buckets.map((b) => <th key={b.key} className="px-2 py-2 text-right font-medium"><i className="mr-1 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: BUCKET_COLOR[b.key] }} />{b.label}</th>)}
                    <th className="px-4 py-2 text-center font-medium">Transferred</th>
                  </tr>
                </thead>
                <tbody>
                  {data.allocations.map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="px-4 py-1.5 text-muted-foreground">{fmtShortDate(a.date)}</td>
                      <td className="px-2 py-1.5">{a.source.invoiceId ? <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: a.source.invoiceId }} className="text-indigo-600 hover:underline">{a.source.number}</Link> : <span className="text-slate-700">{a.source.note ?? "Other income"}</span>}{a.source.title && <span className="ml-1 text-muted-foreground">{a.source.title}</span>}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-800">{fmtMoney(a.income)}</td>
                      {data.buckets.map((b) => {
                        const l = a.lines.find((x) => x.bucket === b.key);
                        return <td key={b.key} className="px-2 py-1.5 text-right tabular-nums text-slate-700">{l ? fmtMoney(l.amount) : "—"}</td>;
                      })}
                      <td className="px-4 py-1.5 text-center">
                        <input type="checkbox" checked={a.transferred} onChange={(e) => transfer.mutate({ id: a.id, transferred: e.target.checked })} title={a.transferred ? "Moved to the bucket accounts" : "Not yet moved"} />
                        {!a.source.invoiceId && <button onClick={() => removeAlloc.mutate(a.id)} className="ml-2 text-slate-300 hover:text-red-600" title="Remove this split">✕</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-6 text-xs text-muted-foreground">{cfg.enabled ? "No income split yet. Record a payment on an invoice and it lands here." : "Turn Profit First on, then record a payment (or split earlier ones) to see allocations."}</p>
            )}
          </section>

          {data.movements.length > 0 && (
            <section className="rounded-lg border border-border bg-white">
              <div className="border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">Distributions & adjustments</h2></div>
              <ul className="divide-y divide-border">
                {data.movements.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-1.5 text-xs">
                    <span className="w-14 text-muted-foreground">{fmtShortDate(m.date)}</span>
                    <i className="inline-block h-2 w-2 rounded-sm" style={{ background: BUCKET_COLOR[m.bucket] }} />
                    <span className="text-slate-700">{data.buckets.find((b) => b.key === m.bucket)?.label}</span>
                    <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">{m.kind}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.note}</span>
                    <span className={cn("tabular-nums", m.amount < 0 ? "text-red-700" : "text-emerald-700")}>{m.amount < 0 ? "−" : "+"}{fmtMoney(Math.abs(m.amount))}</span>
                    <button onClick={() => removeMove.mutate(m.id)} className="text-slate-300 hover:text-red-600" title="Remove">✕</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="text-[11px] text-muted-foreground">Bucket balances are a ledger inside this tool, not a bank feed. Set up matching bank sub-accounts and tick “transferred” after each move. <Link to="/finance/pnl" className="text-indigo-600 hover:underline">Profit &amp; Loss</Link> shows the same income against expenses.</p>
        </div>
      </div>

      {settings && <SettingsDialog cfg={cfg} onClose={() => setSettings(false)} onSaved={() => { setSettings(false); refresh(); }} />}
      {moving && <MoveDialog bucket={moving.bucket} kind={moving.kind} label={data.buckets.find((b) => b.key === moving.bucket)?.label ?? moving.bucket} balance={data.buckets.find((b) => b.key === moving.bucket)?.balance ?? 0} onClose={() => setMoving(null)} onDone={() => { setMoving(null); refresh(); }} />}
      {manual && <ManualDialog cfg={cfg} onClose={() => setManual(false)} onDone={() => { setManual(false); refresh(); }} />}
    </div>
  );
}

function Stat({ label, value, tone, action }: { label: string; value: string; tone?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-baseline gap-3"><p className={cn("text-lg font-semibold tabular-nums text-slate-900", tone)}>{value}</p>{action}</div>
    </div>
  );
}

/** One stacked bar of the current split — the four buckets in fixed order with 2px gaps and direct labels. */
function SplitBar({ buckets }: { buckets: ProfitFirstOverview["buckets"] }) {
  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <p className="mb-2 text-xs font-medium text-slate-700">Every {fmtMoney(100)} that comes in is split like this</p>
      <div className="flex h-8 w-full gap-[2px] overflow-hidden rounded-md">
        {buckets.map((b) => (
          <div key={b.key} className="flex items-center justify-center text-[11px] font-medium text-white" style={{ width: `${b.currentPct}%`, background: BUCKET_COLOR[b.key], minWidth: b.currentPct > 0 ? 2 : 0 }} title={`${b.label} ${b.currentPct}%`}>
            {b.currentPct >= 8 ? `${b.label} ${b.currentPct}%` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsDialog({ cfg, onClose, onSaved }: { cfg: ProfitFirstOverview["config"]; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const [rows, setRows] = useState(cfg.buckets.map((b) => ({ ...b, currentPct: String(b.currentPct), targetPct: String(b.targetPct) })));
  const [startedAt, setStartedAt] = useState(cfg.startedAt ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRows(cfg.buckets.map((b) => ({ ...b, currentPct: String(b.currentPct), targetPct: String(b.targetPct) }))), [cfg]);
  const sum = rows.reduce((a, r) => a + (Number(r.currentPct) || 0), 0);
  const save = useMutation({
    mutationFn: () => api.updateProfitFirst({ startedAt: startedAt || null, buckets: rows.map((r) => ({ key: r.key, label: r.label, currentPct: Number(r.currentPct) || 0, targetPct: Number(r.targetPct) || 0 })) }),
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const presets: { name: string; pct: [number, number, number, number] }[] = [
    { name: "Under $250k", pct: [5, 50, 15, 30] },
    { name: "$250k–$500k", pct: [10, 35, 15, 40] },
    { name: "$500k–$1M", pct: [15, 20, 15, 50] },
    { name: "Start gently", pct: [1, 50, 15, 34] },
  ];
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Allocation percentages</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">“Current” is what gets applied to each payment now; “target” is where you are heading. Nudge current toward target every quarter.</p>
        <div className="mt-3 flex flex-wrap gap-1 text-[11px]">
          <span className="text-muted-foreground">Presets:</span>
          {presets.map((p) => (
            <button key={p.name} type="button" onClick={() => setRows((l) => l.map((r, i) => ({ ...r, targetPct: String(p.pct[i]) })))} className="rounded border border-border px-2 py-0.5 text-slate-600 hover:bg-muted" title="Sets the targets">{p.name}</button>
          ))}
        </div>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-left font-medium">Bucket</th><th className="py-1 text-right font-medium">Current %</th><th className="py-1 text-right font-medium">Target %</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} className="border-t border-border">
                <td className="py-1.5"><span className="flex items-center gap-2"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BUCKET_COLOR[r.key] }} /><input value={r.label} onChange={(e) => set(i, { label: e.target.value })} className="w-40 rounded border border-transparent bg-transparent px-1 hover:border-border focus:border-indigo-400" /></span></td>
                <td className="py-1.5 text-right"><input type="number" min="0" max="100" step="0.5" value={r.currentPct} onChange={(e) => set(i, { currentPct: e.target.value })} className="w-20 rounded border border-border px-2 py-1 text-right tabular-nums" /></td>
                <td className="py-1.5 text-right"><input type="number" min="0" max="100" step="0.5" value={r.targetPct} onChange={(e) => set(i, { targetPct: e.target.value })} className="w-20 rounded border border-border px-2 py-1 text-right tabular-nums text-slate-600" /></td>
              </tr>
            ))}
            <tr className="border-t border-border text-xs"><td className="py-1.5 text-muted-foreground">Total</td><td className={cn("py-1.5 text-right tabular-nums font-medium", Math.abs(sum - 100) > 0.01 ? "text-red-700" : "text-emerald-700")}>{Math.round(sum * 100) / 100}%</td><td /></tr>
          </tbody>
        </table>
        <div className="mt-3 max-w-xs"><CrmField label="Split payments received on or after"><input type="date" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} className={input} /></CrmField></div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => save.mutate()} disabled={Math.abs(sum - 100) > 0.01 || save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save</button>
        </div>
      </div>
    </>
  );
}

function MoveDialog({ bucket, kind, label, balance, onClose, onDone }: { bucket: ProfitBucket; kind: "distribution" | "adjustment"; label: string; balance: number; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(isoDay(new Date()));
  const [note, setNote] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({ mutationFn: () => api.addProfitMovement({ bucket, amount: Number(amount), date: new Date(date).toISOString(), note: note || null, kind, direction }), onSuccess: onDone, onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")) });
  const title = kind === "distribution" ? (bucket === "tax" ? `Pay tax from ${label}` : bucket === "owner_pay" ? "Pay the owner" : bucket === "profit" ? "Profit distribution" : `Spend from ${label}`) : `Adjust ${label}`;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Balance {fmtMoney(balance)}. {kind === "distribution" ? "Records money leaving the bucket." : "A correction in either direction (opening balance, bank interest, a mistake)."}</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Amount"><input autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={input} /></CrmField>
          <CrmField label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></CrmField>
          {kind === "adjustment" && (
            <CrmField label="Direction">
              <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")} className={input}><option value="in">Add to bucket</option><option value="out">Take out of bucket</option></select>
            </CrmField>
          )}
          <div className="col-span-2"><CrmField label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder={kind === "distribution" ? "Q3 profit distribution" : "Opening balance"} /></CrmField></div>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => run.mutate()} disabled={!(Number(amount) > 0) || run.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Record</button>
        </div>
      </div>
    </>
  );
}

function ManualDialog({ cfg, onClose, onDone }: { cfg: ProfitFirstOverview["config"]; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(isoDay(new Date()));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({ mutationFn: () => api.allocateProfitFirst({ amount: Number(amount), date: new Date(date).toISOString(), note: note || null }), onSuccess: onDone, onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")) });
  const n = Number(amount) || 0;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Split other income</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Money that arrived without an invoice here — a grant, a refund, an old receivable. Invoice payments are split automatically.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Amount"><input autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={input} /></CrmField>
          <CrmField label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></CrmField>
          <div className="col-span-2"><CrmField label="What it was"><input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder="Grant from …" /></CrmField></div>
        </div>
        {n > 0 && (
          <ul className="mt-3 grid grid-cols-4 gap-1 text-[11px]">
            {cfg.buckets.map((b) => <li key={b.key} className="rounded border border-border px-2 py-1"><span className="block text-muted-foreground">{b.label}</span><span className="tabular-nums text-slate-800">{fmtMoney((n * b.currentPct) / 100)}</span></li>)}
          </ul>
        )}
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => run.mutate()} disabled={!(n > 0) || run.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Split</button>
        </div>
      </div>
    </>
  );
}
