import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { CrmField, input } from "../views/CompaniesPage.js";
import { cn } from "../lib/utils.js";

const SOURCE: Record<string, string> = { project_override: "project override", member: "rate card", project_default: "project rate", none: "no rate" };

/**
 * Row 141: what each person bills at on this project — and the overrides
 * (a discounted retainer, a premium engagement) that make it so. Admin only.
 */
export function ProjectRates({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["project-rates", projectId], queryFn: () => api.getProjectRates(projectId) });
  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState(isoDay(new Date()));
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["project-rates", projectId] });
    void qc.invalidateQueries({ queryKey: ["unbilled"] });
  };
  const add = useMutation({ mutationFn: () => api.addProjectRateOverride(projectId, { userId, effectiveFrom: from, billRate: Number(rate) || 0, note: note || null }), onSuccess: () => { setAdding(false); setRate(""); setNote(""); refresh(); }, onError: (e) => setError(errorMessage(e)) });
  const remove = useMutation({ mutationFn: (id: string) => api.removeProjectRateOverride(projectId, id), onSuccess: refresh });
  if (!data) return null;
  const cur = data.project.currency;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (userId) add.mutate();
  }
  return (
    <section className="mt-6 rounded-lg border border-border bg-white" data-testid="project-rates">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bill rates on this project</h2>
        <span className="text-xs text-muted-foreground">{data.project.hourlyRate ? `project rate ${fmtMoney(data.project.hourlyRate, cur)}/h` : "no flat project rate"} · <Link to="/settings" search={{ section: "rates" } as never} className="hover:underline">rate cards</Link></span>
        <button type="button" onClick={() => setAdding((v) => !v)} className="ml-auto rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted">＋ Override a rate</button>
      </div>
      {adding && (
        <form onSubmit={submit} className="grid grid-cols-5 items-end gap-2 border-b border-border bg-[#fbfbfa] px-4 py-3">
          <CrmField label="Person">
            <select value={userId} onChange={(e) => setUserId(e.target.value)} className={input}>
              <option value="">Choose…</option>
              {data.effective.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </select>
          </CrmField>
          <CrmField label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} /></CrmField>
          <CrmField label={`Bill rate (${cur})`}><input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className={input} /></CrmField>
          <CrmField label="Why"><input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder="retainer discount" /></CrmField>
          <button type="submit" disabled={!userId || add.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Set</button>
          {error && <p className="col-span-5 text-xs text-red-600">{error}</p>}
        </form>
      )}
      <ul className="divide-y divide-border">
        {data.effective.map((m) => {
          const ov = data.overrides.filter((o) => o.userId === m.userId);
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
              <span className="w-40 font-medium text-slate-800">{m.name}</span>
              <span className={cn("tabular-nums", m.source === "none" ? "text-amber-700" : "text-slate-900")}>{m.source === "none" ? "no rate" : `${fmtMoney(m.billRate, m.currency)}/h`}</span>
              <span className={cn("rounded px-1.5 py-0.5 text-[10px]", m.source === "project_override" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600")}>{SOURCE[m.source]}</span>
              {ov.length > 0 && (
                <span className="ml-auto flex flex-wrap gap-1">
                  {ov.map((o) => (
                    <span key={o.id} className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5", o.active ? "border-indigo-200 bg-indigo-50/50" : "border-border")} title={o.note ?? undefined}>
                      {fmtMoney(o.billRate, cur)} from {fmtShortDate(o.effectiveFrom)}{!o.active ? " (upcoming)" : ""}
                      <button type="button" onClick={() => remove.mutate(o.id)} className="text-slate-400 hover:text-red-600">✕</button>
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
