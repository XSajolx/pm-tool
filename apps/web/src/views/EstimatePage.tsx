import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type EstimateItem, type EstimateStatus } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { ESTIMATE_STATUS } from "./EstimatesPage.js";
import { NotFound } from "../components/NotFound.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

/** Which buttons a status offers. Mirrors the server's transition table. */
const ACTIONS: Record<EstimateStatus, { label: string; to: EstimateStatus; tone: string }[]> = {
  draft: [{ label: "Mark as sent", to: "sent", tone: "bg-indigo-600 hover:bg-indigo-700 text-white" }],
  sent: [
    { label: "Accepted", to: "accepted", tone: "bg-emerald-600 hover:bg-emerald-700 text-white" },
    { label: "Declined", to: "declined", tone: "border border-border hover:bg-muted text-slate-700" },
    { label: "Expired", to: "expired", tone: "border border-border hover:bg-muted text-slate-700" },
    { label: "Back to draft", to: "draft", tone: "text-slate-500 hover:text-slate-700" },
  ],
  accepted: [],
  declined: [{ label: "Reopen as draft", to: "draft", tone: "border border-border hover:bg-muted text-slate-700" }],
  expired: [{ label: "Reopen as draft", to: "draft", tone: "border border-border hover:bg-muted text-slate-700" }],
};

/**
 * The estimate editor. Everything is editable while it's a draft; once sent it
 * becomes a record and only its status can move. Totals shown here are
 * computed locally for feedback but the server recomputes on save.
 */
export function EstimatePage() {
  const { estimateId } = useParams({ from: "/crm/estimates/$estimateId" });
  const qc = useQueryClient();
  const { data: est, isError } = useQuery({ queryKey: ["estimate", estimateId], queryFn: () => api.getEstimate(estimateId) });
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: deals = [] } = useQuery({ queryKey: ["deals"], queryFn: api.getDeals });

  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [contactId, setContactId] = useState("");
  const [dealId, setDealId] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [taxRate, setTaxRate] = useState("0");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<EstimateItem[]>([]);
  const [dirty, setDirty] = useState(false);

  const { data: contacts = [] } = useQuery({
    queryKey: ["contacts", "company", companyId],
    queryFn: () => api.getContacts({ companyId }),
    enabled: Boolean(companyId),
  });

  useEffect(() => {
    if (!est) return;
    setTitle(est.title);
    setCompanyId(est.company?.id ?? "");
    setContactId(est.contact?.id ?? "");
    setDealId(est.deal?.id ?? "");
    setIssueDate(est.issueDate?.slice(0, 10) ?? "");
    setValidUntil(est.validUntil?.slice(0, 10) ?? "");
    setTaxRate(String(est.taxRate));
    setNotes(est.notes ?? "");
    setItems(est.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })));
    setDirty(false);
  }, [est]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["estimate", estimateId] });
    qc.invalidateQueries({ queryKey: ["estimates"] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.updateEstimate(estimateId, {
        title: title.trim(),
        companyId: companyId || null,
        contactId: contactId || null,
        dealId: dealId || null,
        issueDate: issueDate ? new Date(issueDate).toISOString() : null,
        validUntil: validUntil ? new Date(validUntil).toISOString() : null,
        taxRate: Number(taxRate) || 0,
        notes: notes || null,
        items: items.filter((i) => i.description.trim()),
      }),
    onSuccess: refresh,
  });
  const setStatus = useMutation({
    mutationFn: (status: EstimateStatus) => api.setEstimateStatus(estimateId, status),
    onSuccess: refresh,
  });

  if (isError) return <NotFound what="estimate" />;
  if (!est) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  const editable = est.status === "draft";
  const st = ESTIMATE_STATUS[est.status];
  const subtotal = items.reduce((a, i) => a + i.quantity * i.unitPrice, 0);
  const tax = subtotal * ((Number(taxRate) || 0) / 100);
  const total = subtotal + tax;

  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };
  const setItem = (idx: number, patch: Partial<EstimateItem>) => {
    setItems((list) => list.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
    setDirty(true);
  };

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/crm/estimates" className="text-sm text-muted-foreground hover:text-slate-700">Estimates</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-sm font-semibold text-slate-800">{est.number}</h1>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
        {est.sentAt && <span className="text-xs text-muted-foreground">sent {fmtShortDate(est.sentAt)}</span>}
        {est.acceptedAt && <span className="text-xs text-emerald-700">accepted {fmtShortDate(est.acceptedAt)}</span>}

        <div className="ml-auto flex items-center gap-2">
          {editable && (
            <button
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-muted disabled:opacity-40"
            >
              {save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          )}
          {ACTIONS[est.status].map((a) => (
            <button
              key={a.to}
              onClick={() => setStatus.mutate(a.to)}
              disabled={setStatus.isPending || (a.to === "sent" && dirty)}
              title={a.to === "sent" && dirty ? "Save first" : undefined}
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40", a.tone)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-5">
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
            <CrmField label="Deal">
              <select value={dealId} onChange={(e) => touch(setDealId)(e.target.value)} disabled={!editable} className={input}>
                <option value="">—</option>
                {deals.filter((d) => !companyId || d.company?.id === companyId).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
              </select>
            </CrmField>
            <CrmField label="Issue date"><input type="date" value={issueDate} onChange={(e) => touch(setIssueDate)(e.target.value)} disabled={!editable} className={input} /></CrmField>
            <CrmField label="Valid until"><input type="date" value={validUntil} onChange={(e) => touch(setValidUntil)(e.target.value)} disabled={!editable} className={input} /></CrmField>
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
                      <input value={it.description} onChange={(e) => setItem(idx, { description: e.target.value })} disabled={!editable} placeholder="What is being quoted" className="w-full bg-transparent px-2 py-1.5 text-sm outline-none focus:bg-indigo-50" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" min="0" step="0.5" value={it.quantity} onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })} disabled={!editable} className="w-full bg-transparent px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:bg-indigo-50" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" step="0.01" value={it.unitPrice} onChange={(e) => setItem(idx, { unitPrice: Number(e.target.value) })} disabled={!editable} className="w-full bg-transparent px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:bg-indigo-50" />
                    </td>
                    <td className="px-4 py-1 text-right tabular-nums text-slate-800">{fmtMoney(it.quantity * it.unitPrice, est.currency)}</td>
                    {editable && (
                      <td className="px-2 text-center">
                        <button onClick={() => { setItems((l) => l.filter((_, i) => i !== idx)); setDirty(true); }} className="text-slate-300 hover:text-red-500">✕</button>
                      </td>
                    )}
                  </tr>
                ))}
                {!items.length && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No line items yet.</td></tr>
                )}
              </tbody>
            </table>
            {editable && (
              <div className="border-t border-border px-4 py-2">
                <button onClick={() => { setItems((l) => [...l, { description: "", quantity: 1, unitPrice: 0 }]); setDirty(true); }} className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
                  + Add line
                </button>
              </div>
            )}
            <div className="border-t border-border bg-[#fbfbfa] px-4 py-3">
              <div className="ml-auto w-64 space-y-1 text-sm">
                <div className="flex justify-between text-slate-600"><span>Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal, est.currency)}</span></div>
                <div className="flex justify-between text-slate-600"><span>Tax ({Number(taxRate) || 0}%)</span><span className="tabular-nums">{fmtMoney(tax, est.currency)}</span></div>
                <div className="flex justify-between border-t border-border pt-1 font-semibold text-slate-900"><span>Total</span><span className="tabular-nums">{fmtMoney(total, est.currency)}</span></div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-white p-4">
            <CrmField label="Notes / terms">
              <textarea value={notes} onChange={(e) => touch(setNotes)(e.target.value)} disabled={!editable} rows={3} placeholder="Payment terms, scope assumptions, validity…" className={input + " resize-none"} />
            </CrmField>
          </div>
        </div>
      </div>
    </div>
  );
}
