import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type Contractor, type ContractorDetail } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

/**
 * Row 135: the freelancer directory — who you work with, what they have
 * invoiced across projects, what is still unpaid. Engaging them on a project
 * and logging invoices happens on the project page.
 */
export function ContractorsPage() {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Contractor | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["contractors", showAll], queryFn: () => api.getContractors(showAll) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["contractors"] });
  const archive = useMutation({ mutationFn: (id: string) => api.archiveContractor(id), onSuccess: refresh });
  const totals = rows.reduce((a, r) => ({ invoiced: a.invoiced + r.invoiced, unpaid: a.unpaid + r.unpaid }), { invoiced: 0, unpaid: 0 });

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden" data-testid="contractors-page">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Freelancers</h1>
        <span className="text-xs text-muted-foreground">{rows.length} people · invoiced {fmtMoney(totals.invoiced)}{totals.unpaid > 0 ? ` · ${fmtMoney(totals.unpaid)} unpaid` : ""}</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show inactive</label>
        {admin && <button onClick={() => setAdding(true)} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Add freelancer</button>}
      </div>
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Role</th>
                  <th className="px-3 py-2 text-left font-medium">Contact</th>
                  <th className="px-3 py-2 text-right font-medium">Rate</th>
                  <th className="px-3 py-2 text-right font-medium">Projects</th>
                  <th className="px-3 py-2 text-right font-medium">Invoiced</th>
                  <th className="px-3 py-2 text-right font-medium">Unpaid</th>
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={cn("border-t border-border hover:bg-[#fbfbfa]", !r.active && "opacity-60")}>
                    <td className="px-3 py-2"><button type="button" onClick={() => setOpenId(r.id)} className="font-medium text-slate-900 hover:underline">{r.name}</button>{r.company && <span className="ml-1 text-xs text-muted-foreground">· {r.company}</span>}</td>
                    <td className="px-3 py-2 text-slate-700">{r.role ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{[r.email, r.phone].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.defaultRate != null ? `${fmtMoney(r.defaultRate, r.currency)}/h` : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.projectCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-900">{fmtMoney(r.invoiced, r.currency)}</td>
                    <td className={cn("px-3 py-2 text-right tabular-nums", r.unpaid > 0 ? "font-medium text-amber-700" : "text-muted-foreground")}>{r.unpaid > 0 ? fmtMoney(r.unpaid, r.currency) : "—"}</td>
                    <td className="px-2 text-right text-xs">
                      {admin && <button onClick={() => setEditing(r)} className="mr-2 text-slate-500 hover:text-slate-800">Edit</button>}
                      {admin && r.active && <button onClick={() => archive.mutate(r.id)} className="text-slate-300 hover:text-red-500" title="Archive">✕</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No freelancers yet. Engage one from a project page, or add them here.</p>
        )}
      </div>
      {(adding || editing) && <ContractorDialog existing={editing} onClose={() => { setAdding(false); setEditing(null); }} onDone={() => { setAdding(false); setEditing(null); refresh(); }} />}
      {openId && <ContractorDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function ContractorDialog({ existing, onClose, onDone }: { existing: Contractor | null; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [f, setF] = useState({ name: existing?.name ?? "", email: existing?.email ?? "", phone: existing?.phone ?? "", company: existing?.company ?? "", role: existing?.role ?? "", defaultRate: existing?.defaultRate != null ? String(existing.defaultRate) : "", currency: existing?.currency ?? "USD", notes: existing?.notes ?? "", active: existing?.active ?? true });
  const [error, setError] = useState<string | null>(null);
  const body = { name: f.name.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null, company: f.company.trim() || null, role: f.role.trim() || null, defaultRate: f.defaultRate ? Number(f.defaultRate) : null, currency: f.currency.toUpperCase(), notes: f.notes.trim() || null, active: f.active };
  const save = useMutation({ mutationFn: () => (existing ? api.updateContractor(existing.id, body) : api.createContractor(body)), onSuccess: onDone, onError: (e) => setError(errorMessage(e)) });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (f.name.trim()) save.mutate();
  }
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">{existing ? "Edit freelancer" : "Add freelancer"}</h2>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Name"><input autoFocus value={f.name} onChange={set("name")} className={input} /></CrmField>
          <CrmField label="Role / skill"><input value={f.role} onChange={set("role")} className={input} placeholder="Motion designer" /></CrmField>
          <CrmField label="Email"><input type="email" value={f.email} onChange={set("email")} className={input} /></CrmField>
          <CrmField label="Phone"><input value={f.phone} onChange={set("phone")} className={input} /></CrmField>
          <CrmField label="Trading name"><input value={f.company} onChange={set("company")} className={input} placeholder="optional" /></CrmField>
          <div className="grid grid-cols-[1fr_64px] gap-2">
            <CrmField label="Usual rate / h"><input type="number" min="0" step="0.01" value={f.defaultRate} onChange={set("defaultRate")} className={input} /></CrmField>
            <CrmField label="Cur."><input value={f.currency} onChange={set("currency")} maxLength={3} className={input} /></CrmField>
          </div>
          <div className="col-span-2"><CrmField label="Notes"><textarea value={f.notes} onChange={set("notes")} rows={2} className={cn(input, "resize-none")} /></CrmField></div>
          {existing && <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (shows in pickers)</label>}
        </div>
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!f.name.trim() || save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save</button>
        </div>
      </form>
    </>
  );
}

function ContractorDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  useEscape(onClose);
  const { data } = useQuery({ queryKey: ["contractor", id], queryFn: () => api.getContractor(id) });
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-[520px] flex-col border-l border-border bg-white shadow-xl" data-testid="contractor-drawer">
        {data ? <DrawerBody d={data} onClose={onClose} /> : <p className="p-5 text-sm text-muted-foreground">Loading…</p>}
      </aside>
    </>
  );
}

function DrawerBody({ d, onClose }: { d: ContractorDetail; onClose: () => void }) {
  const unpaid = d.invoices.filter((i) => !i.paidAt && i.kind === "expense" && i.approvalStatus !== "rejected");
  return (
    <>
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-slate-900">{d.name}</h2>
          <p className="text-xs text-muted-foreground">{[d.role, d.company, d.email, d.phone].filter(Boolean).join(" · ")}</p>
        </div>
        <button onClick={onClose} className="rounded px-2 py-1 text-slate-500 hover:bg-muted">✕</button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
        {d.notes && <p className="whitespace-pre-wrap text-slate-700">{d.notes}</p>}
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Projects</h3>
          {d.engagements.length ? (
            <ul className="mt-2 space-y-1">
              {d.engagements.map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-sm">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: e.project?.color }} />
                  <Link to="/projects/$projectId" params={{ projectId: e.projectId }} className="text-slate-800 hover:underline">{e.project?.name}</Link>
                  {e.role && <span className="text-xs text-muted-foreground">{e.role}</span>}
                  {e.agreedAmount != null && <span className="ml-auto text-xs text-slate-600">agreed {fmtMoney(e.agreedAmount, d.currency)}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Not engaged on any project.</p>
          )}
        </section>
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Invoices {unpaid.length > 0 && <span className="ml-1 rounded bg-amber-50 px-1.5 text-amber-800">{unpaid.length} unpaid</span>}</h3>
          {d.invoices.length ? (
            <ul className="mt-2 divide-y divide-border rounded-md border border-border text-xs">
              {d.invoices.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
                  <span className="w-14 text-muted-foreground">{fmtShortDate(i.date)}</span>
                  <span className="font-medium text-slate-800">{i.ref ?? "—"}</span>
                  {i.project && <Link to="/projects/$projectId" params={{ projectId: i.project.id }} className="truncate text-muted-foreground hover:underline">{i.project.name}</Link>}
                  <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium", i.approvalStatus === "pending" ? "bg-amber-50 text-amber-800" : i.approvalStatus === "rejected" ? "bg-red-50 text-red-700" : i.paidAt ? "bg-emerald-50 text-emerald-700" : i.overdue ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-700")}>
                    {i.approvalStatus === "pending" ? "awaiting approval" : i.approvalStatus === "rejected" ? "rejected" : i.paidAt ? "paid" : i.overdue ? "overdue" : "unpaid"}
                  </span>
                  <span className="w-20 text-right tabular-nums text-slate-900">{fmtMoney(i.amount, i.currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">No invoices logged yet — log them from the project page.</p>
          )}
        </section>
      </div>
    </>
  );
}
