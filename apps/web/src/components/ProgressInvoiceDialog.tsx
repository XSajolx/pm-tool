import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { useEscape } from "../lib/useEscape.js";
import { cn } from "../lib/utils.js";

/**
 * Row 137: fixed-fee progress billing. Each stage: fee × hand-set % complete
 * − already billed = due now. Fees are editable right here; tick the stages
 * to bill and get a draft with one line each.
 */
export function ProgressInvoiceDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  useEscape(onClose);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ["progress-billing", projectId], queryFn: () => api.getProgressBilling(projectId) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [fees, setFees] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) setPicked(new Set(data.stages.filter((s) => s.due > 0).map((s) => s.id)));
  }, [data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["progress-billing", projectId] });
    void qc.invalidateQueries({ queryKey: ["stages", projectId] });
  };
  const setFee = useMutation({ mutationFn: ({ id, fee }: { id: string; fee: number | null }) => api.updateStage(id, { feeAmount: fee }), onSuccess: refresh, onError: (e) => setError(errorMessage(e)) });
  const draft = useMutation({
    mutationFn: () => api.draftProgressInvoice({ projectId, stageIds: [...picked] }),
    onSuccess: (inv) => {
      onClose();
      void navigate({ to: "/finance/invoices/$invoiceId", params: { invoiceId: inv.id } });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const dueTotal = data ? data.stages.filter((s) => picked.has(s.id)).reduce((a, s) => a + s.due, 0) : 0;
  const cur = data?.project.currency ?? "USD";

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[760px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-white shadow-xl" data-testid="progress-dialog">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">Progress invoice</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Fixed-fee billing by stage: fee × % complete − what earlier invoices already billed for that stage. The % is the one set by hand on the stage cards.</p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {!data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="w-6 py-1.5" />
                  <th className="py-1.5 font-medium">Stage</th>
                  <th className="py-1.5 text-right font-medium">Fee</th>
                  <th className="py-1.5 text-right font-medium">% complete</th>
                  <th className="py-1.5 text-right font-medium">Earned</th>
                  <th className="py-1.5 text-right font-medium">Billed</th>
                  <th className="py-1.5 text-right font-medium">Due now</th>
                </tr>
              </thead>
              <tbody>
                {data.stages.map((s) => (
                  <tr key={s.id} className={cn("border-b border-border last:border-b-0", s.due <= 0 && "text-muted-foreground")}>
                    <td className="py-2"><input type="checkbox" disabled={s.due <= 0} checked={picked.has(s.id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} /></td>
                    <td className="py-2">
                      <span className="font-medium text-slate-800">{s.index}. {s.name}</span>
                      {s.invoices.length > 0 && (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          on {s.invoices.map((i, k) => <span key={i.id}>{k > 0 ? ", " : ""}<Link to="/finance/invoices/$invoiceId" params={{ invoiceId: i.id }} className="hover:underline">{i.number}</Link></span>)}
                        </span>
                      )}
                      {s.overBilled > 0 && <span className="ml-2 rounded bg-red-50 px-1 text-[10px] text-red-700">over-billed by {fmtMoney(s.overBilled, cur)}</span>}
                    </td>
                    <td className="py-2 text-right">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={fees[s.id] ?? (s.feeAmount ?? "")}
                        placeholder="set fee"
                        onChange={(e) => setFees({ ...fees, [s.id]: e.target.value })}
                        onBlur={(e) => {
                          const v = e.target.value === "" ? null : Number(e.target.value);
                          if (v !== s.feeAmount) setFee.mutate({ id: s.id, fee: v });
                        }}
                        className={cn("w-24 rounded border px-1.5 py-0.5 text-right tabular-nums", s.feeAmount == null ? "border-amber-300 bg-amber-50" : "border-border")}
                      />
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-800" title={s.progressSetAt ? `set ${fmtShortDate(s.progressSetAt)}` : "not set yet"}>{s.progressPct}%</td>
                    <td className="py-2 text-right tabular-nums">{fmtMoney(s.earned, cur)}</td>
                    <td className="py-2 text-right tabular-nums">{s.billed ? `${fmtMoney(s.billed, cur)} (to ${s.billedPct}%)` : "—"}</td>
                    <td className={cn("py-2 text-right font-medium tabular-nums", s.due > 0 ? "text-slate-900" : "")}>{fmtMoney(s.due, cur)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-slate-800">
                  <td />
                  <td className="py-2 font-medium">Total</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(data.totals.fee, cur)}{data.project.budgetAmount != null && Math.abs(data.totals.fee - data.project.budgetAmount) > 0.005 && <span className="ml-1 text-[10px] text-amber-700" title="Stage fees do not add up to the project budget">≠ budget {fmtMoney(data.project.budgetAmount, cur)}</span>}</td>
                  <td />
                  <td className="py-2 text-right tabular-nums">{fmtMoney(data.totals.earned, cur)}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(data.totals.billed, cur)}</td>
                  <td className="py-2 text-right font-semibold tabular-nums">{fmtMoney(data.totals.due, cur)}</td>
                </tr>
              </tfoot>
            </table>
          )}
          {data && data.totals.feesMissing > 0 && <p className="mt-2 text-[11px] text-amber-700">{data.totals.feesMissing} stage{data.totals.feesMissing === 1 ? " has" : "s have"} no fee yet — type one in the Fee column.</p>}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-5 py-3">
          {error && <span className="text-xs text-red-700">{error}</span>}
          <span className="flex-1 text-xs text-slate-700">{picked.size} stage{picked.size === 1 ? "" : "s"} · draft total <b className="tabular-nums text-slate-900">{fmtMoney(dueTotal, cur)}</b></span>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" disabled={!picked.size || draft.isPending} onClick={() => draft.mutate()} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50" data-testid="create-progress-draft">
            {draft.isPending ? "Creating…" : "Create draft invoice"}
          </button>
        </div>
      </div>
    </>
  );
}
