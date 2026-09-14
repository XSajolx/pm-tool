import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ProposalStatus } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

export const PROPOSAL_STATUS: Record<ProposalStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-700" },
  sent: { label: "Sent", cls: "bg-sky-50 text-sky-700" },
  viewed: { label: "Viewed", cls: "bg-indigo-50 text-indigo-700" },
  accepted: { label: "Accepted", cls: "bg-emerald-50 text-emerald-700" },
  declined: { label: "Declined", cls: "bg-red-50 text-red-700" },
};

/** Rows 56-58: every proposal, with where it is in the send → view → sign flow. */
export function ProposalsPage() {
  const [creating, setCreating] = useState(false);
  const { data: proposals = [], isLoading } = useQuery({ queryKey: ["proposals"], queryFn: () => api.getProposals() });
  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Proposals</h1>
        <Link to="/settings" className="ml-auto text-xs text-muted-foreground hover:text-indigo-700" title="Edit proposal templates in Settings">
          ⚙ Templates
        </Link>
        <button onClick={() => setCreating(true)} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New proposal
        </button>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : proposals.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Number</th>
                  <th className="px-4 py-2 text-left font-medium">Title</th>
                  <th className="px-4 py-2 text-left font-medium">Client</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Version</th>
                  <th className="px-4 py-2 text-left font-medium">Recipients</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 text-right font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <tr key={p.id} className="border-t border-border hover:bg-[#fbfbfa]">
                    <td className="px-4 py-2.5">
                      <Link to="/crm/proposals/$proposalId" params={{ proposalId: p.id }} className="text-xs font-medium text-indigo-600">
                        {p.number}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <Link to="/crm/proposals/$proposalId" params={{ proposalId: p.id }} className="font-medium text-slate-800 hover:text-indigo-700">
                        {p.title}
                      </Link>
                      {p.deal && <span className="ml-2 text-xs text-muted-foreground">· {p.deal.title}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{p.company?.name ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", PROPOSAL_STATUS[p.status].cls)}>{PROPOSAL_STATUS[p.status].label}</span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{p.currentVersion ? `v${p.currentVersion}` : "—"}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {p.recipientSummary?.sent ? (
                        <span title="sent · viewed · accepted">
                          {p.recipientSummary.sent} sent · {p.recipientSummary.viewed} viewed · {p.recipientSummary.accepted} signed
                          {p.recipientSummary.declined ? ` · ${p.recipientSummary.declined} declined` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{fmtMoney(p.total, p.currency)}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{fmtShortDate(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">📄</span>
            <p className="text-sm text-muted-foreground">No proposals yet. Start one from a deal.</p>
          </div>
        )}
      </div>
      {creating && <NewProposalDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Pick a deal and a template; the proposal is pre-filled from both. */
export function NewProposalDialog({ dealId: fixedDealId, onClose }: { dealId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: deals = [] } = useQuery({ queryKey: ["deals"], queryFn: api.getDeals });
  const { data: templates = [] } = useQuery({ queryKey: ["proposal-templates"], queryFn: api.getProposalTemplates });
  const [dealId, setDealId] = useState(fixedDealId ?? "");
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createProposal({ dealId, templateId: templateId || undefined, title: title.trim() || undefined }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      onClose();
      navigate({ to: "/crm/proposals/$proposalId", params: { proposalId: p.id } });
    },
    onError: (e) => setError((e as Error).message),
  });
  const openDeals = deals.filter((d) => !d.stage || d.stage.kind === "open" || d.id === fixedDealId);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dealId && !create.isPending) create.mutate();
        }}
        className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold text-slate-900">New proposal</h2>
        <p className="mt-1 text-xs text-muted-foreground">Sections come from the template; client, contact and total come from the deal.</p>
        <div className="mt-4 space-y-3">
          <CrmField label="Deal">
            <select value={dealId} disabled={Boolean(fixedDealId)} onChange={(e) => setDealId(e.target.value)} className={input} required>
              <option value="">Choose a deal…</option>
              {openDeals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                  {d.company ? ` — ${d.company.name}` : ""}
                </option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Template">
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={input}>
              <option value="">Default template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Title (optional)">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={input} placeholder="Defaults to the deal title" />
          </CrmField>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!dealId || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </>
  );
}
