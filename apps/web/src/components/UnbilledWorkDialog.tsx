import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, errorMessage, type UnbilledGroupBy } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "../views/CompaniesPage.js";
import { cn } from "../lib/utils.js";

/**
 * Row 136: everything a project has earned but not invoiced — approved,
 * billable hours and approved, billable expenses — ticked by default, one
 * click to a draft invoice. Hours not yet approved are shown but held back.
 */
export function UnbilledWorkDialog({ projectId: preset, onClose }: { projectId?: string; onClose: () => void }) {
  useEscape(onClose);
  const navigate = useNavigate();
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const [projectId, setProjectId] = useState(preset ?? "");
  const [through, setThrough] = useState(isoDay(new Date()));
  const [onlyApproved, setOnlyApproved] = useState(true);
  const [groupBy, setGroupBy] = useState<UnbilledGroupBy>("person");
  const [pickedEntries, setPickedEntries] = useState<Set<string> | null>(null);
  const [pickedExpenses, setPickedExpenses] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, isFetching } = useQuery({ queryKey: ["unbilled", projectId, through, onlyApproved], queryFn: () => api.getUnbilled(projectId, { through, onlyApproved }), enabled: Boolean(projectId) });

  // Everything ticked whenever the set of eligible work changes.
  useEffect(() => {
    if (!data) return;
    setPickedEntries(new Set(data.hours.entries.map((e) => e.id)));
    setPickedExpenses(new Set(data.expenses.items.map((e) => e.id)));
  }, [data]);

  const entries = data?.hours.entries ?? [];
  const chosen = useMemo(() => entries.filter((e) => pickedEntries?.has(e.id)), [entries, pickedEntries]);
  const chosenExp = useMemo(() => (data?.expenses.items ?? []).filter((e) => pickedExpenses?.has(e.id)), [data, pickedExpenses]);
  const hoursAmount = chosen.reduce((a, e) => a + e.amount, 0);
  const expAmount = chosenExp.reduce((a, e) => a + e.billAmount, 0);
  const togglePerson = (userId: string) =>
    setPickedEntries((s) => {
      const ids = entries.filter((e) => e.userId === userId).map((e) => e.id);
      const n = new Set(s ?? []);
      const all = ids.every((id) => n.has(id));
      for (const id of ids) all ? n.delete(id) : n.add(id);
      return n;
    });

  const draft = useMutation({
    mutationFn: () => api.draftFromUnbilled({ projectId, through: new Date(through).toISOString(), onlyApprovedHours: onlyApproved, groupBy, includeExpenses: chosenExp.length > 0, timeEntryIds: chosen.map((e) => e.id), expenseIds: chosenExp.map((e) => e.id) }),
    onSuccess: (inv) => {
      onClose();
      void navigate({ to: "/finance/invoices/$invoiceId", params: { invoiceId: inv.id } });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-white shadow-xl" data-testid="unbilled-dialog">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">Bill unbilled work</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Approved hours and expenses that have not been invoiced yet become the lines of a draft invoice. Nothing bills twice.</p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <CrmField label="Project">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input} disabled={Boolean(preset)}>
                <option value="">Choose…</option>
                {projects.filter((p) => p.kind !== "internal").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </CrmField>
            <CrmField label="Work through"><input type="date" value={through} onChange={(e) => setThrough(e.target.value)} className={input} /></CrmField>
            <CrmField label="Hours as">
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as UnbilledGroupBy)} className={input}>
                <option value="person">One line per person</option>
                <option value="task">One line per task</option>
                <option value="single">A single line</option>
              </select>
            </CrmField>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} /> Only hours from approved timesheet weeks
            {data && data.hours.awaitingApproval.count > 0 && onlyApproved && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">{data.hours.awaitingApproval.hours}h held back — not approved yet</span>}
          </label>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 text-sm">
          {!projectId ? (
            <p className="text-muted-foreground">Pick a project.</p>
          ) : !data ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <section>
                <div className="flex items-center gap-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Hours</h3>
                  <span className="text-xs text-muted-foreground">{data.hours.hours}h eligible{data.project.hourlyRate ? ` at ${fmtMoney(data.project.hourlyRate, data.project.currency)}/h` : ""}</span>
                  {data.hours.rateMissing && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700">Set an hourly rate on the project first</span>}
                </div>
                {data.hours.byPerson.length ? (
                  <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                    {data.hours.byPerson.map((p) => {
                      const ids = entries.filter((e) => e.userId === p.id).map((e) => e.id);
                      const on = ids.every((id) => pickedEntries?.has(id));
                      const some = ids.some((id) => pickedEntries?.has(id));
                      return (
                        <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                          <input type="checkbox" checked={on} ref={(el) => { if (el) el.indeterminate = !on && some; }} onChange={() => togglePerson(p.id)} />
                          <span className="min-w-0 flex-1 text-slate-800">{p.name} <span className="text-muted-foreground">· {p.count} entr{p.count === 1 ? "y" : "ies"}</span></span>
                          <span className="tabular-nums text-slate-700">{p.hours}h</span>
                          <span className="w-20 text-right tabular-nums text-slate-900">{fmtMoney(p.amount, data.project.currency)}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">No unbilled {onlyApproved ? "approved " : ""}billable hours through {fmtShortDate(through)}.</p>
                )}
              </section>
              <section className="mt-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Expenses</h3>
                  <span className="text-xs text-muted-foreground">{data.expenses.count} approved & billable, with markup</span>
                </div>
                {data.expenses.items.length ? (
                  <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                    {data.expenses.items.map((e) => (
                      <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                        <input type="checkbox" checked={pickedExpenses?.has(e.id) ?? false} onChange={() => setPickedExpenses((s) => { const n = new Set(s ?? []); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} />
                        <span className="w-14 text-muted-foreground">{fmtShortDate(e.date)}</span>
                        <span className="min-w-0 flex-1 truncate text-slate-800">{e.vendor}{e.description ? <span className="text-muted-foreground"> · {e.description}</span> : null}</span>
                        <span className="text-muted-foreground">{fmtMoney(e.amount, e.currency)} +{e.effectiveMarkupPct}%</span>
                        <span className="w-20 text-right tabular-nums text-slate-900">{fmtMoney(e.billAmount, e.currency)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">Nothing to re-bill.</p>
                )}
              </section>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-5 py-3">
          {data && (
            <span className="text-xs text-slate-700">
              {chosen.length ? `${chosen.reduce((a, e) => a + e.hours, 0).toFixed(2)}h = ${fmtMoney(hoursAmount, data.project.currency)}` : "no hours"} · {chosenExp.length} expense{chosenExp.length === 1 ? "" : "s"} = {fmtMoney(expAmount, data.project.currency)} · <b className={cn("tabular-nums", "text-slate-900")}>draft total {fmtMoney(hoursAmount + expAmount, data.project.currency)}</b>
            </span>
          )}
          {error && <span className="text-xs text-red-700">{error}</span>}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" disabled={!data || isFetching || draft.isPending || (!chosen.length && !chosenExp.length) || (chosen.length > 0 && data.hours.rateMissing)} onClick={() => draft.mutate()} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50" data-testid="create-draft">
            {draft.isPending ? "Creating…" : "Create draft invoice"}
          </button>
        </div>
      </div>
    </>
  );
}
