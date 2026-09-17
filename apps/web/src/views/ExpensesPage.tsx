import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type Expense, type ExpenseImportPreview, type ExpenseRule } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Awaiting approval" },
  { key: "rejected", label: "Rejected" },
  { key: "uncategorised", label: "Uncategorised" },
  { key: "billable", label: "Billable, not yet invoiced" },
  { key: "billed", label: "Invoiced" },
  { key: "imported", label: "Imported" },
  { key: "refunds", label: "Refunds" },
  { key: "personal", label: "Personal" },
];

/**
 * Row 160: every cost in one ledger — typed in by hand or pulled from a bank /
 * card statement, categorised by rules, tied to a project, re-billed to the
 * client from the invoice editor.
 */
export function ExpensesPage() {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const qc = useQueryClient();
  const [filter, setFilter] = useState(() => new URLSearchParams(window.location.search).get("filter") ?? "all");
  const [adjusting, setAdjusting] = useState<Expense | null>(null);
  const [rejecting, setRejecting] = useState<Expense | null>(null);
  const [marking, setMarking] = useState<Expense | null>(null);
  const { data: catSettings = [] } = useQuery({ queryKey: ["expense-category-settings"], queryFn: api.getExpenseCategorySettings });
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [panel, setPanel] = useState<"rules" | "imports" | null>(null);
  const { data: expenses = [], isLoading } = useQuery({ queryKey: ["expenses", filter, q], queryFn: () => api.getExpenses({ filter, q: q || undefined }) });
  const { data: totals } = useQuery({ queryKey: ["expense-totals"], queryFn: api.getExpenseTotals });
  const { data: categories = [] } = useQuery({ queryKey: ["expense-categories"], queryFn: api.getExpenseCategories });
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["expenses"] });
    qc.invalidateQueries({ queryKey: ["expense-totals"] });
    qc.invalidateQueries({ queryKey: ["expense-rules"] });
  };
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateExpense>[1] }) => api.updateExpense(id, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteExpense(id), onSuccess: refresh });
  // Row 133
  const approve = useMutation({ mutationFn: (id: string) => api.approveExpense(id), onSuccess: refresh });
  const resubmit = useMutation({ mutationFn: (id: string) => api.resubmitExpense(id), onSuccess: refresh });
  const [remember, setRemember] = useState<{ id: string; vendor: string; category: string } | null>(null);
  const shown = expenses.reduce((a, e) => a + (e.kind === "refund" ? -e.amount : e.amount), 0);

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">{admin ? "Expenses" : "My expenses"}</h1>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor or note…" className="w-56 rounded-md border border-border px-2.5 py-1 text-xs outline-none focus:border-indigo-500" />
        <div className="ml-auto flex items-center gap-2">
          <Link to="/expense" className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-muted md:hidden">📷 Quick entry</Link>
          {admin && <button onClick={() => setPanel(panel === "rules" ? null : "rules")} className={cn("rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted", panel === "rules" ? "bg-indigo-50 text-indigo-700" : "text-slate-700")}>Rules</button>}
          {admin && <button onClick={() => setPanel(panel === "imports" ? null : "imports")} className={cn("rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted", panel === "imports" ? "bg-indigo-50 text-indigo-700" : "text-slate-700")}>Imports</button>}
          {admin && <button onClick={() => setImporting(true)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-muted">Import statement</button>}
          <button onClick={() => setAdding(true)} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">Add expense</button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {admin ? (
            <Tile label="Awaiting approval" value={String(totals?.pendingCount ?? 0)} hint={totals?.pendingAmount ? `${fmtMoney(totals.pendingAmount)} waiting` : "queue is clear"} tone={totals?.pendingCount ? "text-amber-700" : undefined} onClick={() => setFilter("pending")} active={filter === "pending"} />
          ) : (
            <Tile label="This month" value={fmtMoney(totals?.thisMonth ?? 0)} hint="business spend, net of refunds" />
          )}
          <Tile label="Uncategorised" value={String(totals?.uncategorised ?? 0)} hint="need a category" tone={totals?.uncategorised ? "text-amber-700" : undefined} onClick={() => setFilter("uncategorised")} active={filter === "uncategorised"} />
          <Tile label="Billable, not invoiced" value={fmtMoney(totals?.unbilledBillable ?? 0)} hint={`${totals?.unbilledCount ?? 0} to re-bill`} tone="text-indigo-700" onClick={() => setFilter("billable")} active={filter === "billable"} />
          <Tile label="Personal this month" value={fmtMoney(totals?.personalThisMonth ?? 0)} hint="excluded from P&L" onClick={() => setFilter("personal")} active={filter === "personal"} />
        </div>

        {panel === "rules" && <RulesPanel admin={admin} categories={categories} onClose={() => setPanel(null)} />}
        {panel === "imports" && <ImportsPanel admin={admin} onClose={() => setPanel(null)} onFilter={(id) => { setFilter("imported"); void id; }} />}

        <div className="mb-3 flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)} className={cn("rounded-full border px-3 py-1 text-xs font-medium transition", filter === f.key ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:bg-muted")}>{f.label}</button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">{expenses.length} shown · {fmtMoney(shown)}</span>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : expenses.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Vendor</th>
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                  <th className="px-3 py-2 text-left font-medium">Project</th>
                  <th className="px-3 py-2 text-center font-medium">Billable</th>
                  <th className="px-3 py-2 text-center font-medium">Personal</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => {
                  const locked = Boolean(e.invoiceId);
                  const approved = e.approvalStatus === "approved" && Boolean(e.submittedAt);
                  return (
                    <tr key={e.id} className={cn("border-t border-border hover:bg-[#fbfbfa]", e.personal && "opacity-60")}>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{fmtShortDate(e.date)}</td>
                      <td className="px-3 py-1.5">
                        <p className="font-medium text-slate-800">{e.vendor}</p>
                        <p className="max-w-md truncate text-[11px] text-muted-foreground">
                          {e.receiptUrl && <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="mr-1 rounded bg-slate-100 px-1 text-[10px] text-slate-700 hover:bg-slate-200" title="Open receipt">🧾 receipt</a>}
                          {admin && e.createdBy && <span className="mr-1 text-[10px]">by {e.createdBy.name} ·</span>}
                          {e.approvalStatus === "pending" && <span className="mr-1 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-800">awaiting approval</span>}
                          {e.approvalStatus === "rejected" && <span className="mr-1 rounded bg-red-50 px-1 text-[10px] font-medium text-red-700" title={e.decisionNote ?? undefined}>rejected{e.decisionNote ? `: ${e.decisionNote}` : ""}</span>}
                          {approved && <span className="mr-1 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700" title={`Approved by ${e.decidedBy?.name ?? "—"}${e.decisionNote ? ` · ${e.decisionNote}` : ""}`}>approved · locked</span>}
                          {e.adjustsExpenseId && <span className="mr-1 rounded bg-slate-100 px-1 text-[10px] text-slate-600">adjustment</span>}
                          {e.billable && !e.personal && (() => {
                            const cat = catSettings.find((c) => c.name === e.category);
                            const pct = e.markupPct ?? cat?.markupPct ?? 0;
                            return (
                              <button
                                type="button"
                                disabled={!admin || locked}
                                onClick={() => setMarking(e)}
                                title={e.markupPct != null ? `Overridden by a manager: ${e.markupNote ?? ""}` : cat ? `${cat.name} default markup` : "No category markup"}
                                className={cn("mr-1 rounded px-1 text-[10px]", e.markupPct != null ? "bg-amber-50 text-amber-800" : "bg-indigo-50 text-indigo-700", admin && !locked && "hover:ring-1 hover:ring-indigo-300")}
                                data-testid="markup-chip"
                              >
                                +{pct}% markup{e.markupPct != null ? " (override)" : ""} → {fmtMoney(e.amount * (1 + pct / 100), e.currency)}
                              </button>
                            );
                          })()}
                          {e.description}
                          {e.source === "import" && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px]">imported{e.account ? ` · ${e.account}` : ""}</span>}
                          {e.invoice && <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: e.invoice.id }} className="ml-1 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">on {e.invoice.number}</Link>}
                        </p>
                      </td>
                      <td className="px-3 py-1.5">
                        <select
                          value={e.category ?? ""}
                          onChange={(ev) => {
                            const category = ev.target.value || null;
                            update.mutate({ id: e.id, body: { category } });
                            if (category && e.source === "import") setRemember({ id: e.id, vendor: e.vendor, category });
                          }}
                          className={cn("w-44 rounded border px-1.5 py-1 text-xs", e.category ? "border-border" : "border-amber-300 bg-amber-50")}
                        >
                          <option value="">— uncategorised —</option>
                          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-1.5">
                        <select value={e.projectId ?? ""} onChange={(ev) => update.mutate({ id: e.id, body: { projectId: ev.target.value || null } })} disabled={locked} className="w-40 rounded border border-border px-1.5 py-1 text-xs disabled:opacity-60">
                          <option value="">—</option>
                          {projects.filter((p) => p.kind !== "internal").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-1.5 text-center"><input type="checkbox" checked={e.billable} disabled={locked || approved} onChange={(ev) => update.mutate({ id: e.id, body: { billable: ev.target.checked } })} /></td>
                      <td className="px-3 py-1.5 text-center"><input type="checkbox" checked={e.personal} disabled={locked || approved} onChange={(ev) => update.mutate({ id: e.id, body: { personal: ev.target.checked } })} /></td>
                      <td className={cn("px-3 py-1.5 text-right tabular-nums", e.kind === "refund" ? "text-emerald-700" : "text-slate-800")}>{e.kind === "refund" ? "+" : ""}{fmtMoney(e.amount, e.currency)}</td>
                      <td className="whitespace-nowrap px-2 text-center text-[11px]">
                        {e.approvalStatus === "pending" && admin && (
                          <span className="inline-flex gap-1" data-testid="approve-strip">
                            <button onClick={() => approve.mutate(e.id)} className="rounded bg-emerald-600 px-1.5 py-0.5 font-medium text-white hover:bg-emerald-700">Approve</button>
                            <button onClick={() => setRejecting(e)} className="rounded border border-border px-1.5 py-0.5 text-slate-700 hover:bg-muted">Reject</button>
                          </span>
                        )}
                        {e.approvalStatus === "rejected" && <button onClick={() => resubmit.mutate(e.id)} className="rounded border border-border px-1.5 py-0.5 text-slate-700 hover:bg-muted">Resubmit</button>}
                        {approved && admin && !locked && <button onClick={() => setAdjusting(e)} className="rounded border border-border px-1.5 py-0.5 text-slate-700 hover:bg-muted" title="Approved expenses are locked; record a correction">Adjust</button>}
                        {admin && !locked && !approved && e.approvalStatus !== "pending" && <button onClick={() => remove.mutate(e.id)} className="text-slate-300 hover:text-red-500" title="Delete">✕</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">🧾</span>
            <p className="text-sm text-muted-foreground">{filter === "all" ? "No expenses yet. Add one, or import a bank / card statement." : "Nothing here."}</p>
          </div>
        )}
      </div>

      {remember && (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-white px-4 py-2.5 text-xs shadow-xl">
          <span>Always file <b>{remember.vendor}</b> as <b>{remember.category}</b>?</span>
          <button onClick={() => { update.mutate({ id: remember.id, body: { category: remember.category, rememberVendor: true, applyToSimilar: true } }); setRemember(null); }} className="rounded-md bg-indigo-600 px-2.5 py-1 font-medium text-white">Yes, and re-file similar</button>
          <button onClick={() => { update.mutate({ id: remember.id, body: { category: remember.category, rememberVendor: true } }); setRemember(null); }} className="rounded-md border border-border px-2.5 py-1 text-slate-700">Just remember</button>
          <button onClick={() => setRemember(null)} className="text-slate-400 hover:text-slate-700">No</button>
        </div>
      )}
      {marking && <MarkupDialog expense={marking} categories={catSettings} onClose={() => setMarking(null)} onDone={() => { setMarking(null); refresh(); }} />}
      {rejecting && <RejectDialog expense={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); refresh(); }} />}
      {adjusting && <AdjustDialog expense={adjusting} onClose={() => setAdjusting(null)} onDone={() => { setAdjusting(null); refresh(); }} />}
      {adding && <AddExpenseDialog categories={categories} onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />}
      {importing && <ImportDialog categories={categories} onClose={() => setImporting(false)} onDone={() => { setImporting(false); refresh(); setFilter("imported"); }} />}
    </div>
  );
}

function Tile({ label, value, hint, tone, onClick, active }: { label: string; value: string; hint?: string; tone?: string; onClick?: () => void; active?: boolean }) {
  const Cmp = onClick ? "button" : "div";
  return (
    <Cmp onClick={onClick} className={cn("rounded-lg border bg-white p-3 text-left transition", onClick && "hover:border-indigo-200", active ? "border-indigo-300 ring-2 ring-indigo-500/15" : "border-border")}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums text-slate-900", tone)}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Cmp>
  );
}

/** Row 134: a manager overrides the category markup on one expense, with a note. */
function MarkupDialog({ expense, categories, onClose, onDone }: { expense: Expense; categories: { name: string; markupPct: number }[]; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const def = categories.find((c) => c.name === expense.category)?.markupPct ?? 0;
  const [pct, setPct] = useState(String(expense.markupPct ?? def));
  const [note, setNote] = useState(expense.markupNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (reset: boolean) => api.setExpenseMarkup(expense.id, reset ? { markupPct: null } : { markupPct: Number(pct) || 0, note: note.trim() }), onSuccess: onDone, onError: (e) => setError(errorMessage(e)) });
  const bill = expense.amount * (1 + (Number(pct) || 0) / 100);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) save.mutate(false); }} className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl" data-testid="markup-dialog">
        <h2 className="text-base font-semibold text-slate-900">Markup for {expense.vendor}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{expense.category ? `${expense.category} defaults to +${def}%` : "No category, so the default is +0%"} (set in Settings › Expense categories). Override here for this expense only.</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <CrmField label="Markup %"><input type="number" min="0" max="500" step="0.5" value={pct} onChange={(e) => setPct(e.target.value)} className={input} autoFocus /></CrmField>
          <div className="self-end pb-1.5 text-xs text-slate-700">Bills as <b className="tabular-nums">{fmtMoney(bill, expense.currency)}</b> on {fmtMoney(expense.amount, expense.currency)}</div>
          <div className="col-span-2"><CrmField label="Why (required)"><input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder="Client contract caps expenses at cost / rush print / …" /></CrmField></div>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex items-center gap-2">
          {expense.markupPct != null && <button type="button" onClick={() => save.mutate(true)} className="text-xs text-slate-500 hover:text-slate-800">Back to the category default</button>}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!note.trim() || save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Override</button>
        </div>
      </form>
    </>
  );
}

/** Row 133: a rejection always carries a reason so the member can fix it. */
function RejectDialog({ expense, onClose, onDone }: { expense: Expense; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reject = useMutation({ mutationFn: () => api.rejectExpense(expense.id, note.trim()), onSuccess: onDone, onError: (e) => setError(errorMessage(e)) });
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) reject.mutate(); }} className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl" data-testid="reject-dialog">
        <h2 className="text-base font-semibold text-slate-900">Reject {fmtMoney(expense.amount, expense.currency)} at {expense.vendor}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{expense.createdBy?.name ?? "The submitter"} will see this note and can fix and resubmit.</p>
        <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Why it is not approved…" className={cn(input, "mt-3 resize-none")} />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!note.trim() || reject.isPending} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">Reject</button>
        </div>
      </form>
    </>
  );
}

/** Row 133: approved expenses are locked; a correction is a linked adjustment for the difference. */
function AdjustDialog({ expense, onClose, onDone }: { expense: Expense; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const current = expense.amount + (expense.adjustments ?? []).reduce((a, x) => a + (x.kind === "refund" ? -x.amount : x.amount), 0);
  const [amount, setAmount] = useState(String(current));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const adjust = useMutation({ mutationFn: () => api.adjustExpense(expense.id, { amount: Number(amount), note: note.trim() }), onSuccess: onDone, onError: (e) => setError(errorMessage(e)) });
  const diff = Number(amount) - current;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={(e) => { e.preventDefault(); if (note.trim() && Number(amount) >= 0) adjust.mutate(); }} className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl" data-testid="adjust-dialog">
        <h2 className="text-base font-semibold text-slate-900">Adjust {expense.vendor}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">The approved {fmtMoney(expense.amount, expense.currency)} stays as recorded. A linked correction of the difference is added, already approved.</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <CrmField label="Corrected amount"><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={input} autoFocus /></CrmField>
          <div className="self-end pb-1.5 text-xs text-slate-700">{Number.isFinite(diff) && Math.abs(diff) >= 0.005 ? <>Records a {diff < 0 ? <b className="text-emerald-700">refund of {fmtMoney(-diff, expense.currency)}</b> : <b>charge of {fmtMoney(diff, expense.currency)}</b>}</> : "No change yet"}</div>
          <div className="col-span-2"><CrmField label="Reason"><input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder="Tip was personal / wrong currency / …" /></CrmField></div>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!note.trim() || Math.abs(diff) < 0.005 || adjust.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Record adjustment</button>
        </div>
      </form>
    </>
  );
}

function AddExpenseDialog({ categories, onClose, onDone }: { categories: readonly string[]; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const [date, setDate] = useState(isoDay(new Date()));
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [projectId, setProjectId] = useState("");
  const [billable, setBillable] = useState(false);
  const [personal, setPersonal] = useState(false);
  const [receiptUrl, setReceiptUrl] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const e = await api.createExpense({ date: new Date(date).toISOString(), vendor: vendor.trim(), description: description || null, amount: Number(amount), ...(category ? { category } : {}), projectId: projectId || null, billable, personal, receiptUrl: receiptUrl || null });
      // Row 132: the receipt photo rides along; the expense then points at the stored file.
      if (photo) await api.uploadFile(photo, { expenseId: e.id });
      return e;
    },
    onSuccess: onDone,
    onError: (e) => setError(errorMessage(e)),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (vendor.trim() && Number(amount) > 0) create.mutate();
  }
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Add expense</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Leave the category blank and it is guessed from the vendor.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Vendor"><input autoFocus value={vendor} onChange={(e) => setVendor(e.target.value)} className={input} placeholder="Figma" /></CrmField>
          <CrmField label="Amount"><input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={input} /></CrmField>
          <CrmField label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></CrmField>
          <CrmField label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
              <option value="">Guess from vendor</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </CrmField>
          <div className="col-span-2"><CrmField label="Note"><input value={description} onChange={(e) => setDescription(e.target.value)} className={input} placeholder="What it was for" /></CrmField></div>
          <CrmField label="Project">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input}>
              <option value="">—</option>
              {projects.filter((p) => p.kind !== "internal").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </CrmField>
          <CrmField label="Receipt">
            <div className="flex items-center gap-2">
              <label className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs text-slate-700 hover:bg-muted">
                {photo ? "Change" : "📷 Photo / PDF"}
                <input type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} data-testid="receipt-input" />
              </label>
              {photo ? <span className="min-w-0 truncate text-xs text-slate-700" title={photo.name}>{photo.name}</span> : <input value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} className={cn(input, "min-w-0 flex-1")} placeholder="or paste a link" />}
            </div>
          </CrmField>
          <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable to the client</label>
          <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} /> Personal (exclude from P&L)</label>
        </div>
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!vendor.trim() || !(Number(amount) > 0) || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{create.isPending ? "Saving…" : "Add expense"}</button>
        </div>
      </form>
    </>
  );
}

/** Pick a CSV → server parses + suggests → review table → import. */
function ImportDialog({ categories, onClose, onDone }: { categories: readonly string[]; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const [filename, setFilename] = useState("");
  const [account, setAccount] = useState("");
  const [preview, setPreview] = useState<ExpenseImportPreview | null>(null);
  const [rows, setRows] = useState<ExpenseImportPreview["rows"]>([]);
  const [error, setError] = useState<string | null>(null);
  const parse = useMutation({
    mutationFn: (text: string) => api.previewExpenseImport(text),
    onSuccess: (p) => { setPreview(p); setRows(p.rows); setError(null); },
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  const commit = useMutation({
    mutationFn: () => api.commitExpenseImport({ filename: filename || "statement.csv", account: account || null, rows: rows.map((r) => ({ date: r.date ?? "", vendor: r.vendor, description: r.description, amount: r.amount, kind: r.kind, currency: r.currency, reference: r.reference, category: r.category, projectId: r.projectId, billable: r.billable, personal: r.personal, skip: r.skip })) }),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  const onFile = (f: File | undefined) => {
    if (!f) return;
    setFilename(f.name);
    const reader = new FileReader();
    reader.onload = () => parse.mutate(String(reader.result ?? ""));
    reader.readAsText(f);
  };
  const set = (i: number, patch: Partial<ExpenseImportPreview["rows"][number]>) => setRows((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const selected = rows.filter((r) => !r.skip);
  const total = selected.reduce((a, r) => a + (r.kind === "refund" ? -r.amount : r.amount), 0);
  const stats = useMemo(() => preview && { dup: preview.duplicates, ref: preview.refunds, bad: preview.unreadable }, [preview]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(1100px,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-white shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">Import a bank / card statement</h2>
          <span className="text-xs text-muted-foreground">CSV export from your bank or card. Columns are detected automatically.</span>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700">✕</button>
        </div>
        {!preview ? (
          <div className="p-6">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
              onClick={() => fileRef.current?.click()}
              className="flex h-40 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border text-sm text-slate-600 hover:border-indigo-300 hover:bg-indigo-50/30"
            >
              <span className="text-2xl">📄</span>
              <p className="mt-2">Drop a CSV here or click to choose</p>
              <p className="text-xs text-muted-foreground">Date, description and amount (or debit / credit) columns are all it needs.</p>
              <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </div>
            <div className="mt-4 max-w-sm"><CrmField label="Account label (optional)"><input value={account} onChange={(e) => setAccount(e.target.value)} className={input} placeholder="Business Visa ••4242" /></CrmField></div>
            {parse.isPending && <p className="mt-3 text-xs text-muted-foreground">Reading…</p>}
            {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b border-border bg-[#fbfbfa] px-5 py-2 text-xs text-slate-600">
              <span><b>{filename}</b> · {preview.total} rows</span>
              {stats && <span>{stats.dup} duplicate{stats.dup === 1 ? "" : "s"} · {stats.ref} refund{stats.ref === 1 ? "" : "s"} · {stats.bad} unreadable — unticked by default</span>}
              <span className="text-muted-foreground">Detected: {[preview.columns.date && `date=${preview.columns.date}`, preview.columns.description && `text=${preview.columns.description}`, preview.columns.amount && `amount=${preview.columns.amount}`, preview.columns.debit && `debit=${preview.columns.debit}`, preview.columns.credit && `credit=${preview.columns.credit}`].filter(Boolean).join(", ")}{preview.headerless ? " (no header found, assumed date · description · amount)" : ""}</span>
              <button onClick={() => setRows((l) => l.map((r) => ({ ...r, skip: r.problems.length > 0 })))} className="ml-auto rounded border border-border bg-white px-2 py-0.5 hover:bg-muted">Tick all</button>
              <button onClick={() => setRows((l) => l.map((r) => ({ ...r, skip: true })))} className="rounded border border-border bg-white px-2 py-0.5 hover:bg-muted">Untick all</button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white text-[11px] text-muted-foreground shadow-[0_1px_0_0_#e5e7eb]">
                  <tr>
                    <th className="px-3 py-2 text-left"></th>
                    <th className="px-2 py-2 text-left font-medium">Date</th>
                    <th className="px-2 py-2 text-left font-medium">Vendor</th>
                    <th className="px-2 py-2 text-left font-medium">Category</th>
                    <th className="px-2 py-2 text-left font-medium">Project</th>
                    <th className="px-2 py-2 text-center font-medium">Billable</th>
                    <th className="px-2 py-2 text-center font-medium">Personal</th>
                    <th className="px-2 py-2 text-right font-medium">Amount</th>
                    <th className="px-2 py-2 text-left font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={cn("border-t border-border", r.skip && "bg-slate-50 text-slate-400")}>
                      <td className="px-3 py-1"><input type="checkbox" checked={!r.skip} disabled={r.problems.length > 0} onChange={(e) => set(i, { skip: !e.target.checked })} /></td>
                      <td className="px-2 py-1 tabular-nums">{r.date ?? <span className="text-red-600">?</span>}</td>
                      <td className="px-2 py-1">
                        <input value={r.vendor} onChange={(e) => set(i, { vendor: e.target.value })} className="w-40 rounded border border-transparent bg-transparent px-1 hover:border-border focus:border-indigo-400" />
                        <p className="max-w-xs truncate text-[10px] text-muted-foreground" title={r.description}>{r.description}</p>
                      </td>
                      <td className="px-2 py-1">
                        <select value={r.category ?? ""} onChange={(e) => set(i, { category: e.target.value || null })} className={cn("w-40 rounded border px-1 py-0.5", r.category ? "border-border" : "border-amber-300 bg-amber-50")}>
                          <option value="">—</option>
                          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        {r.suggestedBy === "rule" && <span className="ml-1 text-[10px] text-indigo-600" title="From one of your rules">rule</span>}
                      </td>
                      <td className="px-2 py-1">
                        <select value={r.projectId ?? ""} onChange={(e) => set(i, { projectId: e.target.value || null })} className="w-36 rounded border border-border px-1 py-0.5">
                          <option value="">—</option>
                          {projects.filter((p) => p.kind !== "internal").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1 text-center"><input type="checkbox" checked={r.billable} onChange={(e) => set(i, { billable: e.target.checked })} /></td>
                      <td className="px-2 py-1 text-center"><input type="checkbox" checked={r.personal} onChange={(e) => set(i, { personal: e.target.checked })} /></td>
                      <td className={cn("px-2 py-1 text-right tabular-nums", r.kind === "refund" && "text-emerald-700")}>{r.kind === "refund" ? "+" : ""}{fmtMoney(r.amount, r.currency ?? "USD")}</td>
                      <td className="px-2 py-1 text-[10px]">
                        {r.duplicate && <span className="rounded bg-amber-50 px-1 text-amber-700">already imported</span>}
                        {r.duplicateInFile && <span className="rounded bg-amber-50 px-1 text-amber-700">repeated in file</span>}
                        {r.kind === "refund" && !r.duplicate && <span className="rounded bg-emerald-50 px-1 text-emerald-700">money in</span>}
                        {r.problems.map((p) => <span key={p} className="rounded bg-red-50 px-1 text-red-700">{p}</span>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-3 border-t border-border px-5 py-3">
              <span className="text-xs text-slate-600"><b>{selected.length}</b> selected · {fmtMoney(total)}{selected.some((r) => !r.category) ? ` · ${selected.filter((r) => !r.category).length} still uncategorised (fine — fix later)` : ""}</span>
              {error && <span className="text-xs text-red-700">{error}</span>}
              <button onClick={() => { setPreview(null); setRows([]); }} className="ml-auto rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Choose another file</button>
              <button onClick={() => commit.mutate()} disabled={!selected.length || commit.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{commit.isPending ? "Importing…" : `Import ${selected.length} expense${selected.length === 1 ? "" : "s"}`}</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function RulesPanel({ admin, categories, onClose }: { admin: boolean; categories: readonly string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: rules = [] } = useQuery({ queryKey: ["expense-rules"], queryFn: api.getExpenseRules });
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const [match, setMatch] = useState("");
  const [category, setCategory] = useState("");
  const [projectId, setProjectId] = useState("");
  const [billable, setBillable] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["expense-rules"] });
  const create = useMutation({ mutationFn: () => api.createExpenseRule({ match: match.trim(), category: category || null, projectId: projectId || null, billable: billable || null }), onSuccess: () => { setMatch(""); refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteExpenseRule(id), onSuccess: refresh });
  return (
    <section className="mb-5 rounded-lg border border-border bg-white p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Auto-categorisation rules</h2>
        <span className="text-xs text-muted-foreground">When the vendor or note contains the text, the expense is filed like this — on import and when you add by hand. Longest match wins.</span>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700">✕</button>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {rules.map((r: ExpenseRule) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 py-1.5 text-xs">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{r.match}</span>
            <span>→ {r.category ?? <span className="text-muted-foreground">no category</span>}</span>
            {r.project && <span className="text-muted-foreground">· {r.project.name}</span>}
            {r.billable && <span className="rounded bg-indigo-50 px-1 text-indigo-700">billable</span>}
            {r.personal && <span className="rounded bg-slate-100 px-1 text-slate-600">personal</span>}
            <span className="ml-auto text-muted-foreground">{r.hits} match{r.hits === 1 ? "" : "es"}</span>
            {admin && <button onClick={() => remove.mutate(r.id)} className="text-slate-400 hover:text-red-600">Delete</button>}
          </li>
        ))}
        {!rules.length && <li className="py-2 text-xs text-muted-foreground">No rules yet. Change a category on an imported expense and choose “remember” to create one.</li>}
      </ul>
      {admin && (
        <form onSubmit={(e) => { e.preventDefault(); if (match.trim().length >= 2) create.mutate(); }} className="mt-3 flex flex-wrap items-end gap-2">
          <CrmField label="When vendor contains"><input value={match} onChange={(e) => setMatch(e.target.value)} className={input} placeholder="figma" /></CrmField>
          <CrmField label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}><option value="">—</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          </CrmField>
          <CrmField label="Project">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input}><option value="">—</option>{projects.filter((p) => p.kind !== "internal").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </CrmField>
          <label className="flex items-center gap-1 pb-2 text-xs text-slate-700"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> billable</label>
          <button type="submit" disabled={match.trim().length < 2 || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Add rule</button>
        </form>
      )}
    </section>
  );
}

function ImportsPanel({ admin, onClose, onFilter }: { admin: boolean; onClose: () => void; onFilter: (id: string) => void }) {
  const qc = useQueryClient();
  const { data: imports = [] } = useQuery({ queryKey: ["expense-imports"], queryFn: api.getExpenseImports });
  const undo = useMutation({ mutationFn: (id: string) => api.undoExpenseImport(id), onSuccess: () => { qc.invalidateQueries({ queryKey: ["expenses"] }); qc.invalidateQueries({ queryKey: ["expense-totals"] }); qc.invalidateQueries({ queryKey: ["expense-imports"] }); } });
  return (
    <section className="mb-5 rounded-lg border border-border bg-white p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Statement imports</h2>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700">✕</button>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {imports.map((im) => (
          <li key={im.id} className="flex flex-wrap items-center gap-3 py-1.5 text-xs">
            <span className="font-medium text-slate-800">{im.filename}</span>
            {im.account && <span className="text-muted-foreground">{im.account}</span>}
            <span className="text-muted-foreground">{fmtShortDate(im.createdAt)}{im.createdBy ? ` by ${im.createdBy.name}` : ""}</span>
            <span className="ml-auto">{im.importedCount} imported · {im.skippedCount} skipped</span>
            <button onClick={() => onFilter(im.id)} className="text-indigo-600 hover:underline">show</button>
            {admin && <button onClick={() => undo.mutate(im.id)} className="text-slate-400 hover:text-red-600" title="Removes the imported rows that are not on an invoice">Undo</button>}
          </li>
        ))}
        {!imports.length && <li className="py-2 text-xs text-muted-foreground">No imports yet.</li>}
      </ul>
    </section>
  );
}

export type { Expense };
