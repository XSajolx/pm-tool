import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type StageBurn } from "../lib/api.js";
import { fmtMoney } from "../lib/format.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "../views/CompaniesPage.js";
import { cn } from "../lib/utils.js";

/**
 * Rows 150-152 on a stage card: hour and $ budget with the burn of each
 * beside the hand-set % complete — a stage at 90% burn and 40% complete
 * reads as trouble at a glance. Cost lines are admin-only.
 */
export function StageBudgetLine({ burn, projectId, currency, canManage, admin }: { burn: StageBurn | undefined; projectId: string; currency: string; canManage: boolean; admin: boolean }) {
  const [editing, setEditing] = useState(false);
  if (!burn) return null;
  const hasBudget = burn.budgetHours != null || (admin && burn.budgetAmount != null);
  const tone = (pct: number | null) => (pct == null ? "bg-slate-300" : pct > 100 ? "bg-red-500" : pct - burn.progressPct >= 25 && pct >= 50 ? "bg-amber-500" : "bg-emerald-500");
  return (
    <div className="space-y-1" data-testid="stage-budget">
      {hasBudget ? (
        <>
          {burn.budgetHours != null && (
            <div className="text-[10px]" title={`${burn.usedHours}h logged on this stage of ${burn.budgetHours}h budget`}>
              <div className="flex justify-between text-slate-600"><span>Hours</span><span className={cn("tabular-nums", (burn.hoursPct ?? 0) > 100 && "font-semibold text-red-700")}>{burn.usedHours}h / {burn.budgetHours}h · {burn.hoursPct}%</span></div>
              <div className="mt-0.5 h-1 overflow-hidden rounded bg-slate-100"><div className={cn("h-full", tone(burn.hoursPct))} style={{ width: `${Math.min(100, burn.hoursPct ?? 0)}%` }} /></div>
            </div>
          )}
          {admin && burn.budgetAmount != null && (
            <div className="text-[10px]" title="Hours × each person's cost rate on the day, vs the $ budget">
              <div className="flex justify-between text-slate-600"><span>Cost</span><span className={cn("tabular-nums", (burn.costPct ?? 0) > 100 && "font-semibold text-red-700")}>{fmtMoney(burn.usedCost, currency)} / {fmtMoney(burn.budgetAmount, currency)} · {burn.costPct}%</span></div>
              <div className="mt-0.5 h-1 overflow-hidden rounded bg-slate-100"><div className={cn("h-full", tone(burn.costPct))} style={{ width: `${Math.min(100, burn.costPct ?? 0)}%` }} /></div>
            </div>
          )}
          {burn.atRisk && <p className="text-[10px] font-medium text-amber-700" title="Burn is well ahead of the hand-set % complete">⚠ burn {Math.max(burn.hoursPct ?? 0, burn.costPct ?? 0)}% vs {burn.progressPct}% complete</p>}
          {burn.overBudget && !burn.atRisk && <p className="text-[10px] font-medium text-red-700">Over budget</p>}
          {burn.alerts.length > 0 && <p className="text-[9px] text-muted-foreground">alerts sent: {burn.alerts.map((a) => a.replace("stage_", "").replace("_", " ")).join(", ")}</p>}
        </>
      ) : (
        canManage && <p className="text-[10px] text-muted-foreground">No budget set</p>
      )}
      {canManage && <button type="button" onClick={() => setEditing(true)} className="text-[10px] text-indigo-700 hover:underline">{hasBudget ? "Edit budget" : "Set budget"}</button>}
      {editing && <BudgetDialog burn={burn} projectId={projectId} currency={currency} admin={admin} onClose={() => setEditing(false)} />}
    </div>
  );
}

function BudgetDialog({ burn, projectId, currency, admin, onClose }: { burn: StageBurn; projectId: string; currency: string; admin: boolean; onClose: () => void }) {
  useEscape(onClose);
  const qc = useQueryClient();
  const [hours, setHours] = useState(burn.budgetHours != null ? String(burn.budgetHours) : "");
  const [amount, setAmount] = useState(burn.budgetAmount != null ? String(burn.budgetAmount) : "");
  const [fee, setFee] = useState(burn.feeAmount != null ? String(burn.feeAmount) : "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.updateStage(burn.id, { budgetHours: hours === "" ? null : Number(hours), ...(admin ? { budgetAmount: amount === "" ? null : Number(amount), feeAmount: fee === "" ? null : Number(fee) } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["stages", projectId] });
      void qc.invalidateQueries({ queryKey: ["stage-burn", projectId] });
      void qc.invalidateQueries({ queryKey: ["progress-billing", projectId] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl" data-testid="budget-dialog">
        <h2 className="text-base font-semibold text-slate-900">Budget for {burn.name}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">The ceiling before the stage starts. Alerts go to the project lead and admins at 75, 90 and 100% of either — once each.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Hour budget"><input type="number" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} className={input} autoFocus placeholder="none" /></CrmField>
          {admin && <CrmField label={`Cost budget (${currency})`}><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={input} placeholder="none" /></CrmField>}
          {admin && <CrmField label={`Client fee (${currency}) · row 137`}><input type="number" min="0" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} className={input} placeholder="none" /></CrmField>}
        </div>
        {burn.usedHours > 0 && <p className="mt-2 text-xs text-muted-foreground">Already used: {burn.usedHours}h{admin ? ` · ${fmtMoney(burn.usedCost, currency)}` : ""}</p>}
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save</button>
        </div>
      </form>
    </>
  );
}
