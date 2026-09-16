import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Invoice, type InvoiceItem, type PaymentMethod } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { useEscape } from "../lib/useEscape.js";
import { NotFound } from "../components/NotFound.js";
import { CrmField, input } from "./CompaniesPage.js";
import { InvoiceChip } from "./InvoicesPage.js";
import { NewScheduleDialog } from "./SchedulesPage.js";
import { cn } from "../lib/utils.js";

/** The client-facing link for an issued invoice (row 156). */
export function invoiceLink(token: string) {
  const base = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}`;
  return `${base}/i/${token}`;
}

const METHODS: { key: PaymentMethod; label: string }[] = [
  { key: "bank_transfer", label: "Bank transfer" },
  { key: "card", label: "Card" },
  { key: "cash", label: "Cash" },
  { key: "cheque", label: "Cheque" },
  { key: "other", label: "Other" },
];

/**
 * Row 156: the invoice editor. Everything is editable while it's a draft; once
 * sent it becomes a record — money moves it (payments), and admins can void or
 * pull it back to draft while nothing has been paid.
 */
export function InvoicePage() {
  const { invoiceId } = useParams({ from: "/finance/invoices/$invoiceId" });
  const qc = useQueryClient();
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const { data: inv, isError } = useQuery({ queryKey: ["invoice", invoiceId], queryFn: () => api.getInvoice(invoiceId) });
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });

  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [contactId, setContactId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [taxRate, setTaxRate] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<InvoiceItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [recurring, setRecurring] = useState(false);
  const [addingExpenses, setAddingExpenses] = useState(false);

  const { data: contacts = [] } = useQuery({ queryKey: ["contacts", "company", companyId], queryFn: () => api.getContacts({ companyId }), enabled: Boolean(companyId) });

  useEffect(() => {
    if (!inv) return;
    setTitle(inv.title);
    setCompanyId(inv.company?.id ?? "");
    setContactId(inv.contact?.id ?? "");
    setProjectId(inv.project?.id ?? "");
    setCurrency(inv.currency);
    setIssueDate(inv.issueDate.slice(0, 10));
    setDueDate(inv.dueDate?.slice(0, 10) ?? "");
    setTaxRate(String(inv.taxRate));
    setDiscount(String(inv.discountPercent));
    setNotes(inv.notes ?? "");
    setItems(inv.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })));
    setDirty(false);
  }, [inv]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["invoice-totals"] });
  };
  const fail = (e: unknown) => setError((e as Error).message.replace(/^API \d+: /, ""));
  const ok = () => {
    setError(null);
    refresh();
  };

  const save = useMutation({
    mutationFn: () =>
      api.updateInvoice(invoiceId, {
        title: title.trim(),
        companyId: companyId || null,
        contactId: contactId || null,
        projectId: projectId || null,
        currency: currency.trim().toUpperCase().slice(0, 3) || "USD",
        issueDate: issueDate ? new Date(issueDate).toISOString() : null,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
        taxRate: Number(taxRate) || 0,
        discountPercent: Number(discount) || 0,
        notes: notes || null,
        items: items.filter((i) => i.description.trim()),
      }),
    onSuccess: ok,
    onError: fail,
  });
  const send = useMutation({ mutationFn: () => api.sendInvoice(invoiceId), onSuccess: () => { ok(); setShareOpen(true); }, onError: fail });
  const reopen = useMutation({ mutationFn: () => api.reopenInvoice(invoiceId), onSuccess: ok, onError: fail });
  const doVoid = useMutation({ mutationFn: (reason: string) => api.voidInvoice(invoiceId, reason), onSuccess: () => { ok(); setVoiding(false); }, onError: fail });
  const unpay = useMutation({ mutationFn: (pid: string) => api.removeInvoicePayment(invoiceId, pid), onSuccess: ok, onError: fail });
  const pdf = useMutation({ mutationFn: () => api.openInvoicePdf(invoiceId), onError: fail });

  if (isError) return <NotFound what="invoice" />;
  if (!inv) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  const editable = inv.status === "draft";
  const open = inv.status === "sent" || inv.status === "viewed" || inv.status === "partially_paid";
  const subtotal = items.reduce((a, i) => a + i.quantity * i.unitPrice, 0);
  const discountAmt = subtotal * ((Number(discount) || 0) / 100);
  const tax = (subtotal - discountAmt) * ((Number(taxRate) || 0) / 100);
  const total = subtotal - discountAmt + tax;

  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };
  const setItem = (idx: number, patch: Partial<InvoiceItem>) => {
    setItems((list) => list.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
    setDirty(true);
  };
  const btn = "rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40";
  const ghost = `${btn} border border-border text-slate-700 hover:bg-muted`;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/finance/invoices" className="text-sm text-muted-foreground hover:text-slate-700">Invoices</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-sm font-semibold text-slate-800">{inv.number}</h1>
        <InvoiceChip inv={inv} />
        {inv.sentAt && <span className="text-xs text-muted-foreground">sent {fmtShortDate(inv.sentAt)}</span>}
        {inv.viewedAt && <span className="text-xs text-indigo-700">viewed {fmtShortDate(inv.viewedAt)} ({inv.viewCount}×)</span>}
        {inv.paidAt && <span className="text-xs text-emerald-700">paid {fmtShortDate(inv.paidAt)}</span>}
        {inv.voidedAt && <span className="text-xs text-slate-500">void {fmtShortDate(inv.voidedAt)}{inv.voidReason ? ` · ${inv.voidReason}` : ""}</span>}
        {inv.schedule && (
          <Link to="/finance/recurring/$scheduleId" params={{ scheduleId: inv.schedule.id }} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 hover:bg-indigo-100">
            ↻ {inv.schedule.name}{inv.schedule.status === "active" && inv.schedule.nextRunAt ? ` · next ${fmtShortDate(inv.schedule.nextRunAt)}` : ` · ${inv.schedule.status}`}
          </Link>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button onClick={() => pdf.mutate()} disabled={pdf.isPending} className={ghost}>PDF</button>
          {!inv.schedule && inv.status !== "void" && <button onClick={() => setRecurring(true)} className={ghost} title="Repeat this invoice on a schedule">↻ Make recurring</button>}
          {inv.token && inv.status !== "draft" && <button onClick={() => setShareOpen(true)} className={ghost}>Client link</button>}
          {editable && admin && <button onClick={() => setAddingExpenses(true)} disabled={dirty} title={dirty ? "Save first" : "Add billable expenses as lines"} className={ghost}>+ Expenses</button>}
          {editable && (
            <button onClick={() => save.mutate()} disabled={!dirty || save.isPending} className={ghost}>
              {save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          )}
          {editable && admin && (
            <button onClick={() => send.mutate()} disabled={dirty || send.isPending || !items.length} title={dirty ? "Save first" : undefined} className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}>
              {send.isPending ? "Sending…" : "Send"}
            </button>
          )}
          {open && admin && <button onClick={() => setPaying(true)} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>Record payment</button>}
          {open && admin && inv.amountPaid === 0 && <button onClick={() => reopen.mutate()} disabled={reopen.isPending} className="text-sm text-slate-500 hover:text-slate-700">Back to draft</button>}
          {(open || editable) && admin && inv.amountPaid === 0 && <button onClick={() => setVoiding(true)} className="text-sm text-slate-500 hover:text-red-700">Void</button>}
          {inv.status === "void" && admin && <button onClick={() => reopen.mutate()} disabled={reopen.isPending} className={ghost}>Restore as draft</button>}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-700">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[1fr_300px]">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-white p-4 lg:grid-cols-3">
              <div className="lg:col-span-3">
                <CrmField label="Title"><input value={title} onChange={(e) => touch(setTitle)(e.target.value)} disabled={!editable} className={input} /></CrmField>
              </div>
              <CrmField label="Company">
                <select value={companyId} onChange={(e) => { touch(setCompanyId)(e.target.value); setContactId(""); }} disabled={!editable} className={input}>
                  <option value="">—</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </CrmField>
              <CrmField label="Contact">
                <select value={contactId} onChange={(e) => touch(setContactId)(e.target.value)} disabled={!editable || !companyId} className={input}>
                  <option value="">—</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
                </select>
              </CrmField>
              <CrmField label="Project">
                <select value={projectId} onChange={(e) => touch(setProjectId)(e.target.value)} disabled={!editable} className={input}>
                  <option value="">—</option>
                  {projects.filter((p) => p.kind !== "internal").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </CrmField>
              <CrmField label="Issue date"><input type="date" value={issueDate} onChange={(e) => touch(setIssueDate)(e.target.value)} disabled={!editable} className={input} /></CrmField>
              <CrmField label="Due date"><input type="date" value={dueDate} onChange={(e) => touch(setDueDate)(e.target.value)} disabled={!editable} className={input} /></CrmField>
              <CrmField label="Currency"><input value={currency} maxLength={3} onChange={(e) => touch(setCurrency)(e.target.value.toUpperCase())} disabled={!editable} className={input} /></CrmField>
              <CrmField label="Discount (%)"><input type="number" min="0" max="100" step="0.01" value={discount} onChange={(e) => touch(setDiscount)(e.target.value)} disabled={!editable} className={input} /></CrmField>
              <CrmField label="Tax rate (%)"><input type="number" min="0" max="100" step="0.01" value={taxRate} onChange={(e) => touch(setTaxRate)(e.target.value)} disabled={!editable} className={input} /></CrmField>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Description</th>
                    <th className="w-24 px-2 py-2 text-right font-medium">Qty</th>
                    <th className="w-32 px-2 py-2 text-right font-medium">Unit price</th>
                    <th className="w-32 px-4 py-2 text-right font-medium">Amount</th>
                    {editable && <th className="w-8" />}
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={idx} className="border-t border-border">
                      <td className="px-2 py-1">
                        <input value={it.description} onChange={(e) => setItem(idx, { description: e.target.value })} disabled={!editable} placeholder="What is being billed" className="w-full bg-transparent px-2 py-1.5 text-sm outline-none focus:bg-indigo-50 disabled:text-slate-800" />
                      </td>
                      <td className="px-2 py-1">
                        <input type="number" min="0" step="0.5" value={it.quantity} onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })} disabled={!editable} className="w-full bg-transparent px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:bg-indigo-50 disabled:text-slate-800" />
                      </td>
                      <td className="px-2 py-1">
                        <input type="number" step="0.01" value={it.unitPrice} onChange={(e) => setItem(idx, { unitPrice: Number(e.target.value) })} disabled={!editable} className="w-full bg-transparent px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:bg-indigo-50 disabled:text-slate-800" />
                      </td>
                      <td className="px-4 py-1 text-right tabular-nums text-slate-800">{fmtMoney(it.quantity * it.unitPrice, currency)}</td>
                      {editable && (
                        <td className="px-2 text-center">
                          <button onClick={() => { setItems((l) => l.filter((_, i) => i !== idx)); setDirty(true); }} className="text-slate-300 hover:text-red-500">✕</button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {!items.length && <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No line items yet.</td></tr>}
                </tbody>
              </table>
              {editable && (
                <div className="border-t border-border px-4 py-2">
                  <button onClick={() => { setItems((l) => [...l, { description: "", quantity: 1, unitPrice: 0 }]); setDirty(true); }} className="text-sm font-medium text-indigo-600 hover:text-indigo-700">+ Add line</button>
                </div>
              )}
              <div className="border-t border-border bg-[#fbfbfa] px-4 py-3">
                <div className="ml-auto w-72 space-y-1 text-sm">
                  <Row label="Subtotal" value={fmtMoney(subtotal, currency)} />
                  {discountAmt > 0 && <Row label={`Discount (${Number(discount) || 0}%)`} value={`−${fmtMoney(discountAmt, currency)}`} />}
                  <Row label={`Tax (${Number(taxRate) || 0}%)`} value={fmtMoney(tax, currency)} />
                  <div className="flex justify-between border-t border-border pt-1 font-semibold text-slate-900"><span>Total</span><span className="tabular-nums">{fmtMoney(total, currency)}</span></div>
                  {inv.amountPaid > 0 && (
                    <>
                      <Row label="Paid" value={`−${fmtMoney(inv.amountPaid, inv.currency)}`} tone="text-emerald-700" />
                      <div className="flex justify-between border-t border-border pt-1 font-semibold text-slate-900"><span>Balance due</span><span className="tabular-nums">{fmtMoney(inv.balanceDue, inv.currency)}</span></div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-white p-4">
              <CrmField label="Notes / payment instructions">
                <textarea value={notes} onChange={(e) => touch(setNotes)(e.target.value)} disabled={!editable} rows={3} placeholder="Bank details, payment terms, thank-you note…" className={input + " resize-none disabled:text-slate-800"} />
              </CrmField>
            </div>
          </div>

          <aside className="space-y-4">
            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payments</h2>
              {inv.payments.length ? (
                <ul className="mt-2 space-y-2">
                  {inv.payments.map((p) => (
                    <li key={p.id} className="rounded-md border border-border px-2.5 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold tabular-nums text-slate-900">{fmtMoney(p.amount, inv.currency)}</span>
                        <span className="text-muted-foreground">{METHODS.find((m) => m.key === p.method)?.label ?? p.method}</span>
                        <span className="ml-auto text-muted-foreground">{fmtShortDate(p.paidAt)}</span>
                      </div>
                      {(p.reference || p.note) && <p className="mt-0.5 text-muted-foreground">{[p.reference, p.note].filter(Boolean).join(" · ")}</p>}
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        {p.recordedBy && <span>by {p.recordedBy.name}</span>}
                        {admin && inv.status !== "void" && <button onClick={() => unpay.mutate(p.id)} className="ml-auto hover:text-red-700">Remove</button>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">{inv.status === "draft" ? "Send the invoice, then record payments here." : "Nothing received yet."}</p>
              )}
              {open && admin && <button onClick={() => setPaying(true)} className="mt-3 w-full rounded-md border border-border py-1.5 text-xs font-medium text-slate-700 hover:bg-muted">Record payment</button>}
            </section>

            <section className="rounded-lg border border-border bg-white p-4 text-xs text-muted-foreground">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</h2>
              <dl className="mt-2 space-y-1">
                {inv.createdBy && <div className="flex justify-between"><dt>Issued by</dt><dd className="text-slate-700">{inv.createdBy.name}</dd></div>}
                <div className="flex justify-between"><dt>Created</dt><dd className="text-slate-700">{fmtShortDate(inv.createdAt)}</dd></div>
                {inv.estimateId && <div className="flex justify-between"><dt>From estimate</dt><dd><Link to="/crm/estimates/$estimateId" params={{ estimateId: inv.estimateId }} className="text-indigo-600 hover:underline">open</Link></dd></div>}
                {inv.proposalId && <div className="flex justify-between"><dt>From proposal</dt><dd><Link to="/crm/proposals/$proposalId" params={{ proposalId: inv.proposalId }} className="text-indigo-600 hover:underline">open</Link></dd></div>}
                {inv.company && <div className="flex justify-between"><dt>Client</dt><dd><Link to="/crm/companies/$companyId" params={{ companyId: inv.company.id }} className="text-indigo-600 hover:underline">{inv.company.name}</Link></dd></div>}
                {inv.project && <div className="flex justify-between"><dt>Project</dt><dd><Link to="/projects/$projectId" params={{ projectId: inv.project.id }} className="text-indigo-600 hover:underline">{inv.project.name}</Link></dd></div>}
              </dl>
            </section>
          </aside>
        </div>
      </div>

      {paying && <PaymentDialog inv={inv} onClose={() => setPaying(false)} onDone={() => { setPaying(false); ok(); }} />}
      {voiding && <VoidDialog onClose={() => setVoiding(false)} onConfirm={(r) => doVoid.mutate(r)} pending={doVoid.isPending} />}
      {shareOpen && inv.token && <ShareDialog inv={inv} onClose={() => setShareOpen(false)} />}
      {recurring && <NewScheduleDialog fromInvoiceId={inv.id} onClose={() => setRecurring(false)} />}
      {addingExpenses && <AddExpensesDialog inv={inv} onClose={() => setAddingExpenses(false)} onDone={() => { setAddingExpenses(false); ok(); }} />}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={cn("flex justify-between text-slate-600", tone)}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function PaymentDialog({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [amount, setAmount] = useState(String(inv.balanceDue));
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [paidAt, setPaidAt] = useState(isoDay(new Date()));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: () => api.recordInvoicePayment(inv.id, { amount: Number(amount), method, paidAt: paidAt ? new Date(paidAt).toISOString() : null, reference: reference || null, note: note || null }),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  const n = Number(amount);
  const partial = n > 0 && n < inv.balanceDue - 0.005;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (n > 0) record.mutate();
  }
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Record payment</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Balance due {fmtMoney(inv.balanceDue, inv.currency)} on {inv.number}.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label={`Amount (${inv.currency})`}><input autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={input} /></CrmField>
          <CrmField label="Received on"><input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className={input} /></CrmField>
          <CrmField label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={input}>
              {METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </CrmField>
          <CrmField label="Reference"><input value={reference} onChange={(e) => setReference(e.target.value)} className={input} placeholder="Transfer id, cheque no." /></CrmField>
          <div className="col-span-2"><CrmField label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} className={input} /></CrmField></div>
        </div>
        {partial && <p className="mt-2 text-xs text-amber-700">Partial payment — {fmtMoney(inv.balanceDue - n, inv.currency)} will remain due.</p>}
        {n > inv.balanceDue + 0.005 && <p className="mt-2 text-xs text-red-700">More than the balance due. Overpayments are not accepted.</p>}
        {error && <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!(n > 0) || n > inv.balanceDue + 0.005 || record.isPending} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {record.isPending ? "Saving…" : partial ? "Record partial payment" : "Mark as paid"}
          </button>
        </div>
      </form>
    </>
  );
}

function VoidDialog({ onClose, onConfirm, pending }: { onClose: () => void; onConfirm: (reason: string) => void; pending: boolean }) {
  useEscape(onClose);
  const [reason, setReason] = useState("");
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Void this invoice?</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">It keeps its number and stays in the list as void. The client link stops showing a balance.</p>
        <div className="mt-4"><CrmField label="Reason (optional)"><input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className={input} placeholder="Re-issued as INV-0012" /></CrmField></div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => onConfirm(reason)} disabled={pending} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">Void invoice</button>
        </div>
      </div>
    </>
  );
}

/** After sending: the link to hand to the client (no mail provider is wired for invoices yet). */
function ShareDialog({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  useEscape(onClose);
  const [copied, setCopied] = useState(false);
  const link = invoiceLink(inv.token!);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">{inv.status === "sent" && !inv.viewedAt ? "Invoice sent" : "Client link"}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Anyone with this link can view {inv.number} and download the PDF. Send it to {inv.contact?.email ?? inv.contact?.name ?? inv.company?.name ?? "the client"}.
        </p>
        <div className="mt-4 flex items-center gap-1">
          <input readOnly value={link} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded border border-border bg-[#fbfbfa] px-2 py-1.5 text-xs text-slate-700" />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="rounded border border-border px-2 py-1.5 text-xs text-slate-700 hover:bg-muted"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <a href={link} target="_blank" rel="noreferrer" className="rounded border border-border px-2 py-1.5 text-xs text-slate-700 hover:bg-muted">Open</a>
        </div>
        {inv.viewedAt && <p className="mt-3 text-xs text-indigo-700">Opened {inv.viewCount}× · last {fmtShortDate(inv.lastViewedAt ?? inv.viewedAt)}</p>}
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Done</button>
        </div>
      </div>
    </>
  );
}

/** Row 160: pull unbilled billable expenses for this project/client onto the invoice as lines (optional markup). */
function AddExpensesDialog({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const { data: candidates = [], isLoading } = useQuery({ queryKey: ["billable-expenses", inv.project?.id, inv.company?.id], queryFn: () => api.getBillableExpenses({ projectId: inv.project?.id, companyId: inv.company?.id }) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [markup, setMarkup] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({ mutationFn: () => api.addExpensesToInvoice(inv.id, [...picked], Number(markup) || 0), onSuccess: onDone, onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")) });
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const total = candidates.filter((e) => picked.has(e.id)).reduce((a, e) => a + e.amount, 0) * (1 + (Number(markup) || 0) / 100);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Add billable expenses</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{inv.project ? `Unbilled expenses on ${inv.project.name}` : inv.company ? `Unbilled expenses for ${inv.company.name}` : "Set a project or company on the invoice to see matching expenses"}. Each becomes a line; the expense is marked as invoiced.</p>
        <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border">
          {isLoading ? <p className="p-3 text-xs text-muted-foreground">Loading…</p> : candidates.length ? candidates.map((e) => (
            <label key={e.id} className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-xs last:border-b-0 hover:bg-[#fbfbfa]">
              <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
              <span className="w-14 text-muted-foreground">{fmtShortDate(e.date)}</span>
              <span className="min-w-0 flex-1 truncate"><b className="text-slate-800">{e.vendor}</b>{e.description ? <span className="text-muted-foreground"> · {e.description}</span> : null}</span>
              <span className="tabular-nums text-slate-800">{fmtMoney(e.amount, e.currency)}</span>
            </label>
          )) : <p className="p-3 text-xs text-muted-foreground">Nothing billable and unbilled here. Mark expenses as billable on the Expenses page.</p>}
        </div>
        <div className="mt-3 flex items-center gap-3 text-xs">
          <label className="flex items-center gap-2 text-slate-700">Markup <input type="number" min="0" max="100" value={markup} onChange={(e) => setMarkup(e.target.value)} className="w-16 rounded border border-border px-1.5 py-0.5" /> %</label>
          <span className="ml-auto text-slate-700">{picked.size} selected · adds {fmtMoney(total, inv.currency)}</span>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => add.mutate()} disabled={!picked.size || add.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Add to invoice</button>
        </div>
      </div>
    </>
  );
}
