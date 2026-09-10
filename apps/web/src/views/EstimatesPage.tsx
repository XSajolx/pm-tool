import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type EstimateStatus } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

export const ESTIMATE_STATUS: Record<EstimateStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  sent: { label: "Sent", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  accepted: { label: "Accepted", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  declined: { label: "Declined", cls: "bg-red-50 text-red-700 border-red-200" },
  expired: { label: "Expired", cls: "bg-amber-50 text-amber-700 border-amber-200" },
};

/** All estimates. Creating one opens the editor as a draft. */
export function EstimatesPage() {
  const [creating, setCreating] = useState(false);
  const { data: estimates = [], isLoading } = useQuery({ queryKey: ["estimates"], queryFn: () => api.getEstimates() });

  const accepted = estimates.filter((e) => e.status === "accepted").reduce((a, e) => a + e.total, 0);
  const outstanding = estimates.filter((e) => e.status === "sent").reduce((a, e) => a + e.total, 0);

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Estimates</h1>
        <span className="text-xs text-muted-foreground">
          Awaiting reply <span className="font-medium text-slate-700">{fmtMoney(outstanding)}</span> · accepted{" "}
          <span className="font-medium text-slate-700">{fmtMoney(accepted)}</span>
        </span>
        <button onClick={() => setCreating(true)} className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New estimate
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : estimates.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Number</th>
                  <th className="px-4 py-2 text-left font-medium">Title</th>
                  <th className="px-4 py-2 text-left font-medium">Company</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 text-right font-medium">Issued</th>
                </tr>
              </thead>
              <tbody>
                {estimates.map((e) => {
                  const st = ESTIMATE_STATUS[e.status];
                  return (
                    <tr key={e.id} className="border-t border-border hover:bg-[#fbfbfa]">
                      <td className="px-4 py-2.5">
                        <Link to="/crm/estimates/$estimateId" params={{ estimateId: e.id }} className="font-medium text-indigo-600 hover:text-indigo-700">{e.number}</Link>
                      </td>
                      <td className="px-4 py-2.5 text-slate-800">{e.title}</td>
                      <td className="px-4 py-2.5 text-slate-600">{e.company?.name ?? "—"}</td>
                      <td className="px-4 py-2.5"><span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span></td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-800">{fmtMoney(e.total, e.currency)}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{e.issueDate ? fmtShortDate(e.issueDate) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">🧾</span>
            <p className="text-sm text-muted-foreground">No estimates yet.</p>
          </div>
        )}
      </div>

      {creating && <NewEstimateDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewEstimateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");

  const create = useMutation({
    mutationFn: () => api.createEstimate({ title: title.trim(), companyId: companyId || null, items: [] }),
    onSuccess: (est) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      onClose();
      navigate({ to: "/crm/estimates/$estimateId", params: { estimateId: est.id } });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) create.mutate();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">New estimate</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Starts as a draft; add line items in the editor.</p>
        <div className="mt-4 space-y-3">
          <CrmField label="Title"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required className={input} placeholder="Website redesign — phase 1" /></CrmField>
          <CrmField label="Company">
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={input}>
              <option value="">No company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </CrmField>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!title.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create draft"}
          </button>
        </div>
      </form>
    </>
  );
}
