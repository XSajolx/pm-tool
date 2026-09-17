import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type MemberRateCard } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "../views/CompaniesPage.js";
import { cn } from "../lib/utils.js";

/**
 * Row 140: each person's bill rate and cost rate, effective from a date.
 * Old work keeps the rate that applied then; a new card only affects hours
 * from its date on. Owners/admins only — nobody below PM sees cost or margin.
 */
export function RateCardSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ["rate-cards"], queryFn: api.getRateCards, enabled: canEdit });
  const [adding, setAdding] = useState<MemberRateCard | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["rate-cards"] });
  const remove = useMutation({ mutationFn: (id: string) => api.removeRateCard(id), onSuccess: refresh });
  if (!canEdit) return <p className="text-sm text-muted-foreground">Rates, costs and margins are visible to owners and admins only.</p>;

  return (
    <div className="max-w-3xl" data-testid="rate-cards">
      <h1 className="text-lg font-semibold text-slate-900">Rate cards</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        What each person bills at and what an hour costs the agency, from a given date. Past work keeps its old rate; a project can still override the bill rate (on the project page).
      </p>
      {isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Person</th>
                <th className="px-3 py-2 text-right font-medium">Bill rate / h</th>
                <th className="px-3 py-2 text-right font-medium">Cost rate / h</th>
                <th className="px-3 py-2 text-right font-medium">Margin</th>
                <th className="px-3 py-2 text-left font-medium">Since</th>
                <th className="w-40" />
              </tr>
            </thead>
            <tbody>
              {data.map((m) => {
                const c = m.current;
                const margin = c && c.billRate > 0 ? Math.round(((c.billRate - c.costRate) / c.billRate) * 100) : null;
                return (
                  <FragmentRow key={m.userId}>
                    <tr className="border-t border-border">
                      <td className="px-3 py-2"><span className="font-medium text-slate-900">{m.name}</span><span className="ml-1 text-xs text-muted-foreground">{m.role}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-900">{c ? fmtMoney(c.billRate, c.currency) : <span className="text-amber-700">not set</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{c ? fmtMoney(c.costRate, c.currency) : "—"}</td>
                      <td className={cn("px-3 py-2 text-right tabular-nums", margin == null ? "text-muted-foreground" : margin < 30 ? "text-red-700" : "text-emerald-700")}>{margin == null ? "—" : `${margin}%`}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{c ? fmtShortDate(c.effectiveFrom) : "—"}{m.upcoming.length > 0 && <span className="ml-1 rounded bg-indigo-50 px-1 text-[10px] text-indigo-700">+{m.upcoming.length} scheduled</span>}</td>
                      <td className="px-2 text-right text-xs">
                        {m.history.length > 0 && <button onClick={() => setOpen(open === m.userId ? null : m.userId)} className="mr-2 text-slate-500 hover:text-slate-800">{open === m.userId ? "Hide" : "History"}</button>}
                        <button onClick={() => setAdding(m)} className="rounded border border-border px-2 py-0.5 text-slate-700 hover:bg-muted">New rate from…</button>
                      </td>
                    </tr>
                    {open === m.userId && (
                      <tr className="border-t border-border bg-[#fbfbfa]">
                        <td colSpan={6} className="px-3 py-2">
                          <ul className="space-y-1 text-xs">
                            {m.history.map((h) => (
                              <li key={h.id} className="flex items-center gap-3">
                                <span className="w-24 text-slate-700">from {fmtShortDate(h.effectiveFrom)}</span>
                                <span className="tabular-nums">bill {fmtMoney(h.billRate, h.currency)}</span>
                                <span className="tabular-nums text-muted-foreground">cost {fmtMoney(h.costRate, h.currency)}</span>
                                {h.note && <span className="text-muted-foreground">· {h.note}</span>}
                                <span className="ml-auto text-muted-foreground">{h.createdBy ? `by ${h.createdBy.name}` : ""}</span>
                                <button onClick={() => remove.mutate(h.id)} className="text-slate-400 hover:text-red-600">Remove</button>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {adding && <NewRateDialog member={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); refresh(); }} />}
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function NewRateDialog({ member, onClose, onDone }: { member: MemberRateCard; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [from, setFrom] = useState(isoDay(new Date()));
  const [bill, setBill] = useState(member.current ? String(member.current.billRate) : "");
  const [cost, setCost] = useState(member.current ? String(member.current.costRate) : "");
  const [currency, setCurrency] = useState(member.current?.currency ?? "USD");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api.addRateCard({ userId: member.userId, effectiveFrom: from, billRate: Number(bill) || 0, costRate: Number(cost) || 0, currency, note: note || null }), onSuccess: onDone, onError: (e) => setError(errorMessage(e)) });
  const margin = Number(bill) > 0 ? Math.round(((Number(bill) - Number(cost)) / Number(bill)) * 100) : null;
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl" data-testid="rate-dialog">
        <h2 className="text-base font-semibold text-slate-900">New rate for {member.name}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Applies to work from the date on. Earlier hours keep their old rate.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Effective from"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} /></CrmField>
          <CrmField label="Currency"><input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className={input} /></CrmField>
          <CrmField label="Bill rate / hour"><input type="number" min="0" step="0.01" value={bill} onChange={(e) => setBill(e.target.value)} className={input} autoFocus /></CrmField>
          <CrmField label="Cost rate / hour"><input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} className={input} /></CrmField>
          <div className="col-span-2"><CrmField label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder="Annual review / promotion / …" /></CrmField></div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Margin {margin == null ? "—" : `${margin}%`}</p>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save rate</button>
        </div>
      </form>
    </>
  );
}
