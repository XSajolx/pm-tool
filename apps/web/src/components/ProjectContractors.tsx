import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type ContractorInvoice, type ProjectContractors as ProjectContractorsData } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "../views/CompaniesPage.js";
import { cn } from "../lib/utils.js";

/**
 * Row 135: the freelancers on this project and what they have invoiced —
 * agreed vs invoiced, unpaid, and what it re-bills for at their markup, so
 * outside costs are part of the project's cost picture, not a surprise later.
 */
export function ProjectContractors({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["project-contractors", projectId], queryFn: () => api.getProjectContractors(projectId) });
  const [engaging, setEngaging] = useState(false);
  const [logging, setLogging] = useState<ProjectContractorsData["engagements"][number] | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["project-contractors", projectId] });
    void qc.invalidateQueries({ queryKey: ["expenses"] });
    void qc.invalidateQueries({ queryKey: ["contractors"] });
  };
  const paid = useMutation({ mutationFn: ({ id, paid }: { id: string; paid: boolean }) => api.markContractorInvoicePaid(id, { paid }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.disengageContractor(projectId, id), onSuccess: refresh });
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const t = data.totals;

  return (
    <section className="mt-6 rounded-lg border border-border bg-white" data-testid="project-contractors">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Freelancers & outside costs</h2>
        {data.engagements.length > 0 && (
          <span className="text-xs text-muted-foreground">
            invoiced <b className="text-slate-800">{fmtMoney(t.invoiced, t.currency)}</b>
            {t.unpaid > 0 && <> · <b className="text-amber-700">{fmtMoney(t.unpaid, t.currency)} unpaid</b></>}
            {t.billable > 0 && <> · re-bills for <b className="text-indigo-700">{fmtMoney(t.billable, t.currency)}</b></>}
            {t.pendingApproval > 0 && <> · <Link to="/finance/expenses" search={{ filter: "pending" } as never} className="text-amber-700 hover:underline">{t.pendingApproval} awaiting approval</Link></>}
          </span>
        )}
        {canManage && <button type="button" onClick={() => setEngaging(true)} className="ml-auto rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted">＋ Engage a freelancer</button>}
      </div>
      {error && <p className="px-4 pt-2 text-xs text-red-600">{error}</p>}
      {data.engagements.length ? (
        <ul className="divide-y divide-border">
          {data.engagements.map((e) => (
            <li key={e.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link to="/finance/contractors" className="text-sm font-medium text-slate-900 hover:underline">{e.contractor.name}</Link>
                {(e.role ?? e.contractor.role) && <span className="text-xs text-muted-foreground">{e.role ?? e.contractor.role}</span>}
                {e.agreedAmount != null && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">agreed {fmtMoney(e.agreedAmount, t.currency)}</span>}
                {e.agreedRate != null && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">{fmtMoney(e.agreedRate, t.currency)}/h</span>}
                <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700" title="Applied when their invoices are re-billed">+{e.markupPct ?? t.categoryMarkupPct}% markup</span>
                <span className="ml-auto text-xs tabular-nums text-slate-700">
                  invoiced <b>{fmtMoney(e.invoiced, t.currency)}</b>
                  {e.agreedAmount != null && e.invoiced > e.agreedAmount && <span className="ml-1 text-red-700">over agreed</span>}
                  {e.unpaid > 0 && <span className="ml-2 text-amber-700">{fmtMoney(e.unpaid, t.currency)} unpaid</span>}
                </span>
                {canManage && (
                  <span className="flex gap-1">
                    <button type="button" onClick={() => setLogging(e)} className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700">Log invoice</button>
                    {!e.invoices.length && <button type="button" onClick={() => remove.mutate(e.id)} className="rounded-md border border-border px-2 py-0.5 text-[11px] text-slate-600 hover:bg-muted">Remove</button>}
                  </span>
                )}
              </div>
              {e.invoices.length > 0 && (
                <ul className="mt-2 divide-y divide-border rounded-md border border-border text-xs">
                  {e.invoices.map((i) => (
                    <InvoiceRow key={i.id} i={i} currency={t.currency} canManage={canManage} onPaid={(p) => paid.mutate({ id: i.id, paid: p })} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-4 text-sm text-muted-foreground">No freelancers on this project.{canManage ? " Engage one to track their invoices as project cost." : ""}</p>
      )}
      {engaging && <EngageDialog projectId={projectId} onClose={() => setEngaging(false)} onDone={() => { setEngaging(false); refresh(); }} onError={setError} />}
      {logging && <LogInvoiceDialog projectId={projectId} engagement={logging} currency={t.currency} onClose={() => setLogging(null)} onDone={() => { setLogging(null); refresh(); }} />}
    </section>
  );
}

function InvoiceRow({ i, currency, canManage, onPaid }: { i: ContractorInvoice; currency: string; canManage: boolean; onPaid: (paid: boolean) => void }) {
  const state = i.approvalStatus === "pending" ? { label: "awaiting approval", cls: "bg-amber-50 text-amber-800" } : i.approvalStatus === "rejected" ? { label: "rejected", cls: "bg-red-50 text-red-700" } : i.paidAt ? { label: `paid ${fmtShortDate(i.paidAt)}`, cls: "bg-emerald-50 text-emerald-700" } : i.overdue ? { label: `overdue · due ${fmtShortDate(i.dueDate!)}`, cls: "bg-red-50 text-red-700" } : { label: i.dueDate ? `due ${fmtShortDate(i.dueDate)}` : "unpaid", cls: "bg-slate-100 text-slate-700" };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
      <span className="w-14 text-muted-foreground">{fmtShortDate(i.date)}</span>
      <span className="font-medium text-slate-800">{i.ref ?? "—"}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{i.description}</span>
      {i.receiptUrl && <a href={i.receiptUrl} target="_blank" rel="noreferrer" title="Open the invoice file">📎</a>}
      {i.invoice && <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: i.invoice.id }} className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">re-billed on {i.invoice.number}</Link>}
      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", state.cls)}>{state.label}</span>
      <span className={cn("w-20 text-right tabular-nums", i.kind === "refund" ? "text-emerald-700" : "text-slate-900")}>{i.kind === "refund" ? "+" : ""}{fmtMoney(i.amount, i.currency || currency)}</span>
      {canManage && i.approvalStatus !== "rejected" && (
        <button type="button" onClick={() => onPaid(!i.paidAt)} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-muted">{i.paidAt ? "Mark unpaid" : "Mark paid"}</button>
      )}
    </li>
  );
}

function EngageDialog({ projectId, onClose, onDone, onError }: { projectId: string; onClose: () => void; onDone: () => void; onError: (m: string | null) => void }) {
  useEscape(onClose);
  const { data: people = [] } = useQuery({ queryKey: ["contractors"], queryFn: () => api.getContractors() });
  const [contractorId, setContractorId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [agreedAmount, setAgreedAmount] = useState("");
  const [agreedRate, setAgreedRate] = useState("");
  const [markup, setMarkup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const engage = useMutation({
    mutationFn: () => api.engageContractor(projectId, { contractorId: contractorId || null, name: contractorId ? null : name.trim(), email: contractorId ? null : email.trim() || null, role: role.trim() || null, agreedAmount: agreedAmount ? Number(agreedAmount) : null, agreedRate: agreedRate ? Number(agreedRate) : null, markupPct: markup ? Number(markup) : null }),
    onSuccess: () => { onError(null); onDone(); },
    onError: (e) => setError(errorMessage(e)),
  });
  const ready = contractorId || name.trim();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (ready) engage.mutate();
  }
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl" data-testid="engage-dialog">
        <h2 className="text-base font-semibold text-slate-900">Engage a freelancer</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Pick someone you have worked with, or add a new person. What is agreed here shows beside what they invoice.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <CrmField label="Who">
              <select value={contractorId} onChange={(e) => setContractorId(e.target.value)} className={input}>
                <option value="">＋ New person…</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? ` · ${p.role}` : ""}</option>)}
              </select>
            </CrmField>
          </div>
          {!contractorId && (
            <>
              <CrmField label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="Maya Illustrator" /></CrmField>
              <CrmField label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} /></CrmField>
            </>
          )}
          <CrmField label="Role on this project"><input value={role} onChange={(e) => setRole(e.target.value)} className={input} placeholder="Cover illustration" /></CrmField>
          <CrmField label="Markup when re-billed (%)"><input type="number" min="0" max="500" value={markup} onChange={(e) => setMarkup(e.target.value)} className={input} placeholder="category default" /></CrmField>
          <CrmField label="Agreed fee"><input type="number" min="0" step="0.01" value={agreedAmount} onChange={(e) => setAgreedAmount(e.target.value)} className={input} placeholder="fixed" /></CrmField>
          <CrmField label="or rate / hour"><input type="number" min="0" step="0.01" value={agreedRate} onChange={(e) => setAgreedRate(e.target.value)} className={input} /></CrmField>
        </div>
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!ready || engage.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Engage</button>
        </div>
      </form>
    </>
  );
}

function LogInvoiceDialog({ projectId, engagement, currency, onClose, onDone }: { projectId: string; engagement: ProjectContractorsData["engagements"][number]; currency: string; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [ref, setRef] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(isoDay(new Date()));
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [billable, setBillable] = useState(true);
  const [markup, setMarkup] = useState(engagement.markupPct != null ? String(engagement.markupPct) : "");
  const [paid, setPaid] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const log = useMutation({
    mutationFn: async () => {
      const e = await api.logContractorInvoice(engagement.contractorId, { projectId, ref: ref.trim() || null, amount: Number(amount), date: new Date(date).toISOString(), dueDate: dueDate ? new Date(dueDate).toISOString() : null, description: description.trim() || null, billable, markupPct: markup ? Number(markup) : null, paid });
      if (file) await api.uploadFile(file, { expenseId: e.id });
      return e;
    },
    onSuccess: onDone,
    onError: (e) => setError(errorMessage(e)),
  });
  const pct = markup ? Number(markup) : engagement.markupPct ?? null;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={(e) => { e.preventDefault(); if (Number(amount) > 0) log.mutate(); }} className="fixed left-1/2 top-1/2 z-50 w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl" data-testid="log-invoice-dialog">
        <h2 className="text-base font-semibold text-slate-900">Invoice from {engagement.contractor.name}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Logged as a project cost (Contractors & freelancers). Billable ones re-bill at the markup{pct != null ? ` (+${pct}%)` : " of the category"}.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Their invoice #"><input autoFocus value={ref} onChange={(e) => setRef(e.target.value)} className={input} placeholder="MI-001" /></CrmField>
          <CrmField label={`Amount (${currency})`}><input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={input} /></CrmField>
          <CrmField label="Invoice date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></CrmField>
          <CrmField label="Due"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={input} /></CrmField>
          <div className="col-span-2"><CrmField label="What for"><input value={description} onChange={(e) => setDescription(e.target.value)} className={input} placeholder="Cover illustration, 3 rounds" /></CrmField></div>
          <CrmField label="Markup override (%)"><input type="number" min="0" max="500" value={markup} onChange={(e) => setMarkup(e.target.value)} className={input} placeholder="engagement / category" /></CrmField>
          <CrmField label="Invoice file">
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-slate-700 hover:bg-muted">
              {file ? <span className="truncate">{file.name}</span> : "📎 Attach PDF / photo"}
              <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          </CrmField>
          <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Re-bill to the client</label>
          <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Already paid</label>
        </div>
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!(Number(amount) > 0) || log.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{log.isPending ? "Saving…" : "Log invoice"}</button>
        </div>
      </form>
    </>
  );
}
