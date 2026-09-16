import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { InvoiceChip, NewInvoiceDialog } from "../views/InvoicesPage.js";
import { CONTRACT_STATUS } from "../views/ContractsPage.js";
import { cn } from "../lib/utils.js";

/** Row 164: everything money about one client — invoices, what they owe, what they have paid, how fast, what repeats, what is signed. */
export function BillingTab({ companyId }: { companyId: string }) {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["company-billing", companyId], queryFn: () => api.getCompanyBilling(companyId) });
  if (isLoading || !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const t = data.totals;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Outstanding" value={fmtMoney(t.outstanding)} hint={`${t.openCount} open invoice${t.openCount === 1 ? "" : "s"}`} />
        <Stat label="Overdue" value={fmtMoney(t.overdue)} hint={t.overdueCount ? `${t.overdueCount} past due` : "nothing past due"} tone={t.overdue > 0 ? "text-red-700" : undefined} />
        <Stat label="Paid this year" value={fmtMoney(t.thisYear)} hint={`lifetime ${fmtMoney(t.lifetime)}`} tone="text-emerald-700" />
        <Stat label="Pays in" value={t.avgDaysToPay == null ? "—" : `${t.avgDaysToPay} days`} hint={t.lastPaymentAt ? `last payment ${fmtShortDate(t.lastPaymentAt)}` : "no payments yet"} />
      </div>

      <section className="overflow-hidden rounded-lg border border-border bg-white">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Invoices</h3>
          {t.draftCount > 0 && <span className="text-xs text-muted-foreground">{t.draftCount} draft{t.draftCount === 1 ? "" : "s"}</span>}
          <Link to="/finance/invoices" className="ml-auto text-xs text-indigo-600 hover:underline">All invoices</Link>
          {admin && <button onClick={() => setCreating(true)} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700">New invoice</button>}
        </div>
        {data.invoices.length ? (
          <ul>
            {data.invoices.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm last:border-b-0">
                <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: inv.id }} className="text-xs font-medium text-indigo-600">{inv.number}</Link>
                <span className="min-w-0 flex-1 truncate text-slate-800">{inv.title}</span>
                <InvoiceChip inv={inv} />
                <span className="w-20 text-right text-xs text-muted-foreground">{inv.dueDate ? `due ${fmtShortDate(inv.dueDate)}` : ""}</span>
                <span className="w-24 text-right tabular-nums text-slate-700">{fmtMoney(inv.total, inv.currency)}</span>
                <span className={cn("w-24 text-right tabular-nums", inv.status === "paid" || inv.status === "void" ? "text-muted-foreground" : "font-medium text-slate-900")}>{inv.status === "void" ? "—" : fmtMoney(inv.balanceDue, inv.currency)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-5 text-sm text-muted-foreground">No invoices for this client yet.</p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-border bg-white">
          <div className="border-b border-border px-4 py-2.5"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent payments</h3></div>
          {data.payments.length ? (
            <ul className="divide-y divide-border">
              {data.payments.slice(0, 8).map((p, i) => (
                <li key={i} className="flex items-center gap-2 px-4 py-1.5 text-xs"><span className="text-muted-foreground">{fmtShortDate(p.paidAt)}</span><Link to="/finance/invoices/$invoiceId" params={{ invoiceId: p.invoiceId }} className="text-indigo-600">{p.number}</Link><span className="ml-auto tabular-nums text-emerald-700">{fmtMoney(p.amount)}</span></li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-4 text-xs text-muted-foreground">Nothing received yet.</p>
          )}
        </section>
        <section className="rounded-lg border border-border bg-white">
          <div className="flex items-center border-b border-border px-4 py-2.5"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recurring</h3><Link to="/finance/recurring" className="ml-auto text-xs text-indigo-600 hover:underline">Manage</Link></div>
          {data.schedules.length ? (
            <ul className="divide-y divide-border">
              {data.schedules.map((s) => (
                <li key={s.id} className="px-4 py-1.5 text-xs"><Link to="/finance/recurring/$scheduleId" params={{ scheduleId: s.id }} className="font-medium text-slate-800 hover:text-indigo-700">{s.name}</Link><span className="ml-2 text-muted-foreground">every {s.every} {s.unit}{s.every === 1 ? "" : "s"}{s.nextRunAt ? ` · next ${fmtShortDate(s.nextRunAt)}` : ""}</span></li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-4 text-xs text-muted-foreground">No active retainer or subscription.</p>
          )}
        </section>
        <section className="rounded-lg border border-border bg-white">
          <div className="flex items-center border-b border-border px-4 py-2.5"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contracts</h3><Link to="/crm/contracts" className="ml-auto text-xs text-indigo-600 hover:underline">All</Link></div>
          {data.contracts.length ? (
            <ul className="divide-y divide-border">
              {data.contracts.map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-4 py-1.5 text-xs"><Link to="/crm/contracts/$contractId" params={{ contractId: c.id }} className="text-indigo-600">{c.number}</Link><span className="min-w-0 flex-1 truncate text-slate-700">{c.title}</span><span className={cn("rounded-full border px-1.5 py-0.5 text-[10px] font-medium", CONTRACT_STATUS[c.status].cls)}>{CONTRACT_STATUS[c.status].label}</span></li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-4 text-xs text-muted-foreground">No contracts with this client.</p>
          )}
        </section>
      </div>
      {creating && <NewInvoiceDialog companyId={companyId} onClose={() => setCreating(false)} />}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums text-slate-900", tone)}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
