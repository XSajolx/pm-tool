import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

function money(n: number, c: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);
  } catch {
    return `${c} ${n.toFixed(2)}`;
  }
}
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");

/**
 * Row 156: what the client sees from their link — a read-only invoice with the
 * balance, the lines and a PDF. No login, no client account.
 */
export function PublicInvoicePage() {
  const { token } = useParams({ from: "/i/$token" });
  const { data, isError, isLoading } = useQuery({ queryKey: ["public-invoice", token], queryFn: () => api.getPublicInvoice(token), retry: false });

  if (isLoading) return <Shell><p className="text-sm text-slate-500">Loading…</p></Shell>;
  if (isError || !data)
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-slate-900">This link isn't valid</h1>
        <p className="mt-1 text-sm text-slate-600">The invoice may have been withdrawn. Ask the sender for a fresh link.</p>
      </Shell>
    );
  const { invoice: inv, from } = data;
  const state = inv.status === "paid" ? { label: "Paid", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" } : inv.status === "void" ? { label: "Void", cls: "bg-slate-100 text-slate-500 border-slate-200" } : inv.overdue ? { label: "Overdue", cls: "bg-red-50 text-red-700 border-red-200" } : inv.amountPaid > 0 ? { label: "Partially paid", cls: "bg-amber-50 text-amber-700 border-amber-200" } : { label: "Due", cls: "bg-sky-50 text-sky-700 border-sky-200" };
  const bill = [inv.billTo.company, inv.billTo.contact, inv.billTo.email, inv.billTo.address].filter(Boolean) as string[];

  return (
    <Shell brand={from}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wide text-slate-500">Invoice {inv.number}</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">{inv.title}</h1>
          <p className="mt-1 text-sm text-slate-600">From {from.name}{inv.project ? ` · ${inv.project}` : ""}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-right">
          <p className="text-xs text-slate-500">{inv.status === "paid" ? "Paid in full" : inv.status === "void" ? "No longer due" : "Balance due"}</p>
          <p className="text-2xl font-semibold tabular-nums text-slate-900">{money(inv.status === "void" ? 0 : inv.balanceDue, inv.currency)}</p>
          <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${state.cls}`}>{state.label}</span>
        </div>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Bill to</p>
          {bill.length ? bill.map((l, i) => <p key={i} className={i === 0 ? "mt-1 text-sm font-medium text-slate-900" : "text-sm text-slate-600"}>{l}</p>) : <p className="mt-1 text-sm text-slate-500">—</p>}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:justify-self-end">
          <dt className="text-slate-500">Issued</dt><dd className="text-right text-slate-800">{day(inv.issueDate)}</dd>
          <dt className="text-slate-500">Due</dt><dd className={`text-right ${inv.overdue ? "font-medium text-red-700" : "text-slate-800"}`}>{day(inv.dueDate)}</dd>
          {inv.paidAt && <><dt className="text-slate-500">Paid</dt><dd className="text-right text-emerald-700">{day(inv.paidAt)}</dd></>}
        </dl>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 text-right font-medium">Unit price</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.items.map((it) => (
              <tr key={it.id} className="border-t border-slate-100">
                <td className="px-4 py-2.5 text-slate-800">{it.description}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{it.quantity}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{money(it.unitPrice, inv.currency)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{money(it.amount, inv.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
          <div className="ml-auto w-72 space-y-1 text-sm">
            <div className="flex justify-between text-slate-600"><span>Subtotal</span><span className="tabular-nums">{money(inv.subtotal, inv.currency)}</span></div>
            {inv.discountAmount > 0 && <div className="flex justify-between text-slate-600"><span>Discount ({inv.discountPercent}%)</span><span className="tabular-nums">−{money(inv.discountAmount, inv.currency)}</span></div>}
            {(inv.taxRate > 0 || inv.taxAmount > 0) && <div className="flex justify-between text-slate-600"><span>Tax ({inv.taxRate}%)</span><span className="tabular-nums">{money(inv.taxAmount, inv.currency)}</span></div>}
            <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900"><span>Total</span><span className="tabular-nums">{money(inv.total, inv.currency)}</span></div>
            {inv.amountPaid > 0 && (
              <>
                <div className="flex justify-between text-emerald-700"><span>Paid</span><span className="tabular-nums">−{money(inv.amountPaid, inv.currency)}</span></div>
                <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900"><span>Balance due</span><span className="tabular-nums">{money(inv.balanceDue, inv.currency)}</span></div>
              </>
            )}
          </div>
        </div>
      </div>

      {inv.notes && (
        <div className="mt-6">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Notes</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{inv.notes}</p>
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-5">
        <a href={api.publicInvoicePdfUrl(token)} target="_blank" rel="noreferrer" className="rounded-md px-4 py-2 text-sm font-medium text-white" style={{ background: from.color }}>
          Download PDF
        </a>
        <p className="text-xs text-slate-500">Questions about this invoice? Reply to the person who sent it.</p>
      </div>
    </Shell>
  );
}

function Shell({ children, brand }: { children: React.ReactNode; brand?: { name: string; color: string; logoUrl: string | null; footer: string | null } }) {
  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 text-slate-800">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {brand && (
          <div className="flex items-center gap-3 px-6 py-3 sm:px-10" style={{ background: brand.color }}>
            {brand.logoUrl ? <img src={brand.logoUrl} alt="" className="h-7 w-auto rounded bg-white/90 p-0.5" /> : <span className="flex h-7 w-7 items-center justify-center rounded bg-white/20 text-xs font-bold text-white">{brand.name.slice(0, 1)}</span>}
            <span className="text-sm font-semibold text-white">{brand.name}</span>
          </div>
        )}
        <div className="px-6 py-8 sm:px-10">{children}</div>
      </div>
      <p className="mx-auto mt-4 max-w-3xl text-center text-[11px] text-slate-400">{brand?.footer || "Sent with 4S PM Tool"}</p>
    </div>
  );
}
