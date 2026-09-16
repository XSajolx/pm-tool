import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type InvoiceStatus, type InvoiceSummary } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { CrmField, input } from "./CompaniesPage.js";
import { useEscape } from "../lib/useEscape.js";
import { cn } from "../lib/utils.js";

export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  sent: { label: "Sent", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  viewed: { label: "Viewed", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  partially_paid: { label: "Partially paid", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  paid: { label: "Paid", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  void: { label: "Void", cls: "bg-slate-100 text-slate-500 border-slate-200 line-through" },
};

/** The chip shown in lists: an open invoice past its due date reads "Overdue" whatever its stored status. */
export function InvoiceChip({ inv }: { inv: Pick<InvoiceSummary, "status" | "overdue"> }) {
  const st = inv.overdue ? { label: "Overdue", cls: "bg-red-50 text-red-700 border-red-200" } : INVOICE_STATUS[inv.status];
  return <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>;
}

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "outstanding", label: "Outstanding" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
  { key: "void", label: "Void" },
];

/** Row 156: every invoice, with the money at a glance. Creating one opens the editor as a draft. */
export function InvoicesPage() {
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("all");
  const { data: invoices = [], isLoading } = useQuery({ queryKey: ["invoices", filter], queryFn: () => api.getInvoices({ status: filter }) });
  const { data: totals } = useQuery({ queryKey: ["invoice-totals"], queryFn: api.getInvoiceTotals });
  const { data: scheduleTotals } = useQuery({ queryKey: ["schedule-totals"], queryFn: api.getScheduleTotals });

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Invoices</h1>
        <Link to="/finance/recurring" className="text-xs text-muted-foreground hover:text-indigo-700">
          ↻ {scheduleTotals?.active ?? 0} recurring active{scheduleTotals?.nextRunAt ? ` · next ${fmtShortDate(scheduleTotals.nextRunAt)}` : ""}
        </Link>
        <button onClick={() => setCreating(true)} className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New invoice
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="Outstanding" value={fmtMoney(totals?.outstanding ?? 0)} hint={`${totals?.openCount ?? 0} open`} onClick={() => setFilter("outstanding")} active={filter === "outstanding"} />
          <Tile label="Overdue" value={fmtMoney(totals?.overdue ?? 0)} hint={`${totals?.overdueCount ?? 0} past due`} tone={totals?.overdue ? "text-red-700" : undefined} onClick={() => setFilter("overdue")} active={filter === "overdue"} />
          <Tile label="Paid, last 30 days" value={fmtMoney(totals?.paidLast30 ?? 0)} tone="text-emerald-700" onClick={() => setFilter("paid")} active={filter === "paid"} />
          <Tile label="Drafts" value={String(totals?.drafts ?? 0)} hint="not yet sent" onClick={() => setFilter("draft")} active={filter === "draft"} />
        </div>

        <div className="mb-3 flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn("rounded-full border px-3 py-1 text-xs font-medium transition", filter === f.key ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:bg-muted")}
            >
              {f.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : invoices.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Number</th>
                  <th className="px-4 py-2 text-left font-medium">Title</th>
                  <th className="px-4 py-2 text-left font-medium">Client</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Issued</th>
                  <th className="px-4 py-2 text-right font-medium">Due</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-border hover:bg-[#fbfbfa]">
                    <td className="px-4 py-2.5">
                      <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: inv.id }} className="font-medium text-indigo-600 hover:text-indigo-700">{inv.number}</Link>
                    </td>
                    <td className="px-4 py-2.5 text-slate-800">
                      <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: inv.id }} className="hover:text-indigo-700">{inv.title}</Link>
                      {inv.schedule && (
                        <Link to="/finance/recurring/$scheduleId" params={{ scheduleId: inv.schedule.id }} title={`Generated by "${inv.schedule.name}"`} className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 hover:bg-indigo-100">
                          ↻ {inv.schedule.status === "active" && inv.schedule.nextRunAt ? `next ${fmtShortDate(inv.schedule.nextRunAt)}` : "recurring"}
                        </Link>
                      )}
                      {inv.project && <span className="ml-2 text-xs text-muted-foreground">{inv.project.name}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{inv.company?.name ?? inv.contact?.name ?? "—"}</td>
                    <td className="px-4 py-2.5"><InvoiceChip inv={inv} /></td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{fmtShortDate(inv.issueDate)}</td>
                    <td className={cn("px-4 py-2.5 text-right text-xs", inv.overdue ? "font-medium text-red-700" : "text-muted-foreground")}>{inv.dueDate ? fmtShortDate(inv.dueDate) : "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-800">{fmtMoney(inv.total, inv.currency)}</td>
                    <td className={cn("px-4 py-2.5 text-right tabular-nums", inv.status === "paid" || inv.status === "void" ? "text-muted-foreground" : "font-medium text-slate-900")}>
                      {inv.status === "void" ? "—" : fmtMoney(inv.balanceDue, inv.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">🧾</span>
            <p className="text-sm text-muted-foreground">{filter === "all" ? "No invoices yet." : "Nothing here."}</p>
          </div>
        )}
      </div>

      {creating && <NewInvoiceDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function Tile({ label, value, hint, tone, onClick, active }: { label: string; value: string; hint?: string; tone?: string; onClick: () => void; active: boolean }) {
  return (
    <button onClick={onClick} className={cn("rounded-lg border bg-white p-3 text-left transition hover:border-indigo-200", active ? "border-indigo-300 ring-2 ring-indigo-500/15" : "border-border")}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums text-slate-900", tone)}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </button>
  );
}

/** Start from scratch, from an estimate, from a proposal, or for a project. */
export function NewInvoiceDialog({ onClose, companyId: presetCompany, projectId: presetProject }: { onClose: () => void; companyId?: string; projectId?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEscape(onClose);
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const { data: estimates = [] } = useQuery({ queryKey: ["estimates"], queryFn: () => api.getEstimates() });
  const { data: proposals = [] } = useQuery({ queryKey: ["proposals"], queryFn: () => api.getProposals() });

  const [source, setSource] = useState<"blank" | "estimate" | "proposal">("blank");
  const [sourceId, setSourceId] = useState("");
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState(presetCompany ?? "");
  const [projectId, setProjectId] = useState(presetProject ?? "");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createInvoice({
        title: title.trim() || undefined,
        companyId: companyId || undefined,
        projectId: projectId || null,
        fromEstimateId: source === "estimate" ? sourceId : null,
        fromProposalId: source === "proposal" ? sourceId : null,
      }),
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice-totals"] });
      onClose();
      navigate({ to: "/finance/invoices/$invoiceId", params: { invoiceId: inv.id } });
    },
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });

  const needsSource = source !== "blank" && !sourceId;
  const canSubmit = !needsSource && (source !== "blank" || title.trim() || projectId);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) create.mutate();
  }

  const sourceOptions = source === "estimate"
    ? estimates.filter((x) => !companyId || x.company?.id === companyId).map((x) => ({ id: x.id, label: `${x.number} · ${x.title} · ${fmtMoney(x.total, x.currency)}` }))
    : proposals.filter((x) => !companyId || x.companyId === companyId).map((x) => ({ id: x.id, label: `${x.number} · ${x.title} · ${fmtMoney(x.total, x.currency)}` }));

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">New invoice</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Starts as a draft with the next number. Lines can be edited before sending.</p>

        <div className="mt-4 flex gap-1 rounded-md bg-muted p-1 text-xs font-medium">
          {([["blank", "From scratch"], ["estimate", "From estimate"], ["proposal", "From proposal"]] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => { setSource(k); setSourceId(""); }} className={cn("flex-1 rounded px-2 py-1 transition", source === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          <CrmField label="Company">
            <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setSourceId(""); }} className={input}>
              <option value="">No company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </CrmField>
          {source !== "blank" && (
            <CrmField label={source === "estimate" ? "Estimate" : "Proposal"}>
              <select autoFocus value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={input}>
                <option value="">Pick one…</option>
                {sourceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {!sourceOptions.length && <p className="mt-1 text-[11px] text-muted-foreground">Nothing to pick from{companyId ? " for this company" : ""}.</p>}
            </CrmField>
          )}
          <CrmField label="Project (optional)">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input}>
              <option value="">—</option>
              {projects.filter((p) => p.kind !== "internal" && (!companyId || !p.companyId || p.companyId === companyId)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </CrmField>
          <CrmField label={source === "blank" ? "Title" : "Title (optional — defaults to the source title)"}>
            <input autoFocus={source === "blank"} value={title} onChange={(e) => setTitle(e.target.value)} className={input} placeholder="Website redesign — milestone 1" />
          </CrmField>
        </div>

        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!canSubmit || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create draft"}
          </button>
        </div>
      </form>
    </>
  );
}
