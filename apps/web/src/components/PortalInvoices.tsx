import type { PortalBalance, PortalInvoice } from "../lib/api.js";

function money(n: number, c: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);
  } catch {
    return `${c} ${n.toFixed(2)}`;
  }
}
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

/**
 * Row 129: the client's invoices and balance inside the portal. Each row
 * opens the invoice link (/i/<token>), where "Pay now" lives — the portal
 * never handles money itself.
 */
export function PortalInvoices({ invoices, balances, accent, compact }: { invoices: PortalInvoice[]; balances: PortalBalance[]; accent: string; compact?: boolean }) {
  if (!invoices.length) return null;
  const open = invoices.filter((i) => i.balanceDue > 0);
  const settled = invoices.filter((i) => i.balanceDue <= 0);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="portal-invoices">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">Invoices</h2>
          <p className="mt-0.5 text-xs text-slate-500">{open.length ? `${open.length} awaiting payment` : "Nothing outstanding — thank you"}</p>
        </div>
        {balances.map((b) => (
          <div key={b.currency} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-right">
            <p className="text-[11px] text-slate-500">Balance due</p>
            <p className="text-lg font-semibold tabular-nums text-slate-900">{money(b.outstanding, b.currency)}</p>
            {b.overdue > 0 && <p className="text-[11px] font-medium text-red-700">{money(b.overdue, b.currency)} overdue</p>}
          </div>
        ))}
      </div>
      <ul className="mt-3 divide-y divide-slate-100">
        {[...open, ...(compact ? settled.slice(0, 3) : settled)].map((i) => {
          const state = i.balanceDue <= 0 ? { label: "Paid", cls: "bg-emerald-50 text-emerald-700" } : i.overdue ? { label: "Overdue", cls: "bg-red-50 text-red-700" } : i.amountPaid > 0 ? { label: "Part paid", cls: "bg-amber-50 text-amber-700" } : { label: "Due", cls: "bg-sky-50 text-sky-700" };
          const href = i.token ? `/i/${i.token}` : null;
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
              <span className="w-20 text-xs tabular-nums text-slate-500">{i.number}</span>
              <span className="min-w-0 flex-1 truncate text-slate-800">{i.title}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${state.cls}`}>{state.label}</span>
              <span className="w-24 text-right text-xs text-slate-500">{i.balanceDue > 0 ? `due ${day(i.dueDate)}` : `paid ${day(i.paidAt)}`}</span>
              <span className="w-24 text-right tabular-nums text-slate-900">{money(i.balanceDue > 0 ? i.balanceDue : i.total, i.currency)}</span>
              {href && (
                <a href={href} target="_blank" rel="noreferrer" className="rounded-md px-2.5 py-1 text-xs font-medium text-white" style={{ background: i.balanceDue > 0 ? accent : "#94a3b8" }}>
                  {i.balanceDue > 0 ? "View & pay" : "View"}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
