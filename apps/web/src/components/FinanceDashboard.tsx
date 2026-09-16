import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { cn } from "../lib/utils.js";

const BUCKET_COLOR: Record<string, string> = { profit: "#1baf7a", owner_pay: "#2a78d6", tax: "#eda100", opex: "#eb6834" };

/** Row 164: the money view, one click away — on the dashboard for owners and admins. */
export function FinanceDashboard() {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const { data } = useQuery({ queryKey: ["finance-dashboard"], queryFn: api.getFinanceDashboard, enabled: admin });
  if (!admin || !data) return null;
  const c = data.currency;
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Finance</h2>
        <span className="text-xs text-muted-foreground">{data.month.label} · cash basis</span>
        <Link to="/finance/pnl" className="ml-auto text-xs font-medium text-indigo-600 hover:text-indigo-700">Profit &amp; Loss</Link>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Revenue this month" value={fmtMoney(data.month.income, c)} hint={`${fmtMoney(data.ytd.income, c)} year to date`} to="/finance/pnl" />
        <Tile label="Net profit this month" value={fmtMoney(data.month.net, c)} hint={`${fmtMoney(data.ytd.net, c)} YTD${data.ytd.margin != null ? ` · ${data.ytd.margin}% margin` : ""}`} warn={data.month.net < 0} to="/finance/pnl" />
        <Tile label="Outstanding" value={fmtMoney(data.receivables.outstanding, c)} hint={data.receivables.overdueCount ? `${fmtMoney(data.receivables.overdue, c)} overdue (${data.receivables.overdueCount})` : `${data.receivables.openCount} open, none overdue`} warn={data.receivables.overdue > 0} to="/finance/invoices" />
        <Tile label="Expenses this month" value={fmtMoney(data.expenses.thisMonth, c)} hint={data.expenses.uncategorised ? `${data.expenses.uncategorised} uncategorised` : data.expenses.unbilledBillable ? `${fmtMoney(data.expenses.unbilledBillable, c)} billable to re-bill` : "all categorised"} warn={data.expenses.uncategorised > 0} to="/finance/expenses" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Profit First buckets" to="/finance/profit-first">
          {data.profitFirst ? (
            <ul className="space-y-1.5 text-sm">
              {data.profitFirst.buckets.map((b) => (
                <li key={b.key} className="flex items-center gap-2"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BUCKET_COLOR[b.key] }} /><span className="text-slate-700">{b.label}</span><span className="ml-auto tabular-nums text-slate-900">{fmtMoney(b.balance, c)}</span></li>
              ))}
              {data.profitFirst.untransferred > 0 && <li className="pt-1 text-xs text-amber-700">{fmtMoney(data.profitFirst.untransferred, c)} not yet moved to the bank</li>}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Profit First is off. Turn it on to split every payment into profit, pay, tax and expenses.</p>
          )}
        </Panel>
        <Panel title="Coming up" to="/finance/tax">
          <ul className="space-y-2 text-sm">
            {data.nextTax ? (
              <li className={cn("flex items-center gap-2", data.nextTax.status === "overdue" ? "text-red-700" : "text-slate-700")}><span>🧾</span><span>{data.nextTax.label} tax {data.nextTax.status === "overdue" ? "was due" : "due"} {fmtShortDate(data.nextTax.dueDate)}</span><span className="ml-auto tabular-nums">{fmtMoney(data.nextTax.remaining, c)}</span></li>
            ) : (
              <li className="text-muted-foreground">No tax payment due soon.</li>
            )}
            <li className="flex items-center gap-2 text-slate-700"><span>↻</span><span>{data.recurring.active} recurring invoice{data.recurring.active === 1 ? "" : "s"} active</span>{data.recurring.nextRunAt && <span className="ml-auto text-xs text-muted-foreground">next {fmtShortDate(data.recurring.nextRunAt)}</span>}</li>
            <li className="flex items-center gap-2 text-slate-700"><span>✍️</span><span>{data.contractsAwaiting} contract{data.contractsAwaiting === 1 ? "" : "s"} awaiting signature</span><Link to="/crm/contracts" className="ml-auto text-xs text-indigo-600 hover:underline">view</Link></li>
            {data.receivables.drafts > 0 && <li className="flex items-center gap-2 text-slate-700"><span>📝</span><span>{data.receivables.drafts} draft invoice{data.receivables.drafts === 1 ? "" : "s"} not sent</span><Link to="/finance/invoices" className="ml-auto text-xs text-indigo-600 hover:underline">view</Link></li>}
          </ul>
        </Panel>
        <Panel title="Recent payments" to="/finance/invoices">
          {data.recentPayments.length ? (
            <ul className="space-y-1.5 text-sm">
              {data.recentPayments.map((p, i) => (
                <li key={i} className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{fmtShortDate(p.paidAt)}</span><Link to="/finance/invoices/$invoiceId" params={{ invoiceId: p.invoiceId }} className="text-xs font-medium text-indigo-600">{p.number}</Link><span className="min-w-0 flex-1 truncate text-slate-600">{p.company ?? ""}</span><span className="tabular-nums text-emerald-700">{fmtMoney(p.amount, c)}</span></li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
          )}
        </Panel>
      </div>
    </section>
  );
}

function Tile({ label, value, hint, warn, to }: { label: string; value: string; hint?: string; warn?: boolean; to: string }) {
  return (
    <Link to={to} className="rounded-lg border border-border bg-white p-4 transition hover:border-indigo-300">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums text-slate-900", warn && "text-red-600")}>{value}</p>
      {hint && <p className={cn("mt-0.5 text-xs", warn ? "text-red-600" : "text-muted-foreground")}>{hint}</p>}
    </Link>
  );
}

function Panel({ title, to, children }: { title: string; to: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-white">
      <div className="flex items-center border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <Link to={to} className="ml-auto text-xs font-medium text-indigo-600 hover:text-indigo-700">Open</Link>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
