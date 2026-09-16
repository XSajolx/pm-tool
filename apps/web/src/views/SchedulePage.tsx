import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type InvoiceItem, type ScheduleFrequency, type ScheduleKind, type ScheduleUnit } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { NotFound } from "../components/NotFound.js";
import { CrmField, input } from "./CompaniesPage.js";
import { InvoiceChip } from "./InvoicesPage.js";
import { FREQUENCIES, PRESET, SCHEDULE_STATUS, cadenceLabel } from "./SchedulesPage.js";
import { cn } from "../lib/utils.js";

/**
 * Row 157: one billing schedule — the invoice it produces, how often, and the
 * invoices it has produced so far. Pause/resume/end and "Run now" for admins.
 */
export function SchedulePage() {
  const { scheduleId } = useParams({ from: "/finance/recurring/$scheduleId" });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const { data: s, isError } = useQuery({ queryKey: ["schedule", scheduleId], queryFn: () => api.getSchedule(scheduleId) });
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("recurring");
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [contactId, setContactId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [dueDays, setDueDays] = useState("14");
  const [taxRate, setTaxRate] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<InvoiceItem[]>([]);
  const [frequency, setFrequency] = useState<ScheduleFrequency>("monthly");
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<ScheduleUnit>("month");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [maxOcc, setMaxOcc] = useState("");
  const [autoSend, setAutoSend] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const { data: contacts = [] } = useQuery({ queryKey: ["contacts", "company", companyId], queryFn: () => api.getContacts({ companyId }), enabled: Boolean(companyId) });

  useEffect(() => {
    if (!s) return;
    setName(s.name);
    setKind(s.kind);
    setTitle(s.title);
    setCompanyId(s.company?.id ?? "");
    setContactId(s.contact?.id ?? "");
    setProjectId(s.project?.id ?? "");
    setCurrency(s.currency);
    setDueDays(String(s.dueDays));
    setTaxRate(String(s.taxRate));
    setDiscount(String(s.discountPercent));
    setNotes(s.notes ?? "");
    setItems(s.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })));
    setFrequency(s.frequency);
    setEvery(String(s.every));
    setUnit(s.unit);
    setStartsAt(s.startsAt.slice(0, 10));
    setEndsAt(s.endsAt?.slice(0, 10) ?? "");
    setMaxOcc(s.maxOccurrences ? String(s.maxOccurrences) : "");
    setAutoSend(s.autoSend);
    setDirty(false);
  }, [s]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["schedule", scheduleId] });
    qc.invalidateQueries({ queryKey: ["schedules"] });
    qc.invalidateQueries({ queryKey: ["schedule-totals"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["invoice-totals"] });
  };
  const fail = (e: unknown) => setError((e as Error).message.replace(/^API \d+: /, ""));
  const ok = () => {
    setError(null);
    refresh();
  };
  const save = useMutation({
    mutationFn: () =>
      api.updateSchedule(scheduleId, {
        name: name.trim(),
        kind,
        title: title.trim(),
        companyId: companyId || null,
        contactId: contactId || null,
        projectId: projectId || null,
        currency: currency.trim().toUpperCase().slice(0, 3) || "USD",
        dueDays: Number(dueDays) || 0,
        taxRate: Number(taxRate) || 0,
        discountPercent: Number(discount) || 0,
        notes: notes || null,
        items: items.filter((i) => i.description.trim()),
        ...(frequency === "custom" ? { every: Number(every) || 1, unit } : PRESET[frequency]),
        startsAt: startsAt && startsAt !== s?.startsAt.slice(0, 10) ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        maxOccurrences: maxOcc ? Number(maxOcc) : null,
        autoSend,
      }),
    onSuccess: ok,
    onError: fail,
  });
  const pause = useMutation({ mutationFn: () => api.pauseSchedule(scheduleId), onSuccess: ok, onError: fail });
  const resume = useMutation({ mutationFn: () => api.resumeSchedule(scheduleId), onSuccess: ok, onError: fail });
  const end = useMutation({ mutationFn: () => api.endSchedule(scheduleId), onSuccess: () => { ok(); setConfirmEnd(false); }, onError: fail });
  const run = useMutation({ mutationFn: () => api.runSchedule(scheduleId), onSuccess: ok, onError: fail });
  const remove = useMutation({ mutationFn: () => api.archiveSchedule(scheduleId), onSuccess: () => { refresh(); navigate({ to: "/finance/recurring" }); }, onError: fail });

  if (isError) return <NotFound what="schedule" />;
  if (!s) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  const st = SCHEDULE_STATUS[s.status];
  const subtotal = items.reduce((a, i) => a + i.quantity * i.unitPrice, 0);
  const discountAmt = subtotal * ((Number(discount) || 0) / 100);
  const tax = (subtotal - discountAmt) * ((Number(taxRate) || 0) / 100);
  const total = subtotal - discountAmt + tax;
  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };
  const setItem = (idx: number, patch: Partial<InvoiceItem>) => {
    setItems((list) => list.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
    setDirty(true);
  };
  const btn = "rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40";
  const ghost = `${btn} border border-border text-slate-700 hover:bg-muted`;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/finance/recurring" className="text-sm text-muted-foreground hover:text-slate-700">Recurring</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-sm font-semibold text-slate-800">{s.name}</h1>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
        <span className="text-xs text-muted-foreground">{cadenceLabel(s)} · {s.occurrences} generated{s.maxOccurrences ? ` of ${s.maxOccurrences}` : ""}</span>
        {s.status === "active" && s.nextRunAt && <span className="text-xs text-indigo-700">next {fmtShortDate(s.nextRunAt)}{s.autoSend ? " (auto-send)" : " (draft)"}</span>}
        {s.lastError && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700" title={s.lastError}>last run failed</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button onClick={() => save.mutate()} disabled={!dirty || save.isPending} className={ghost}>{save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}</button>
          {admin && s.status !== "ended" && <button onClick={() => run.mutate()} disabled={run.isPending || dirty || !items.length} title={dirty ? "Save first" : "Generate the next invoice now"} className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}>{run.isPending ? "Generating…" : "Run now"}</button>}
          {admin && s.status === "active" && <button onClick={() => pause.mutate()} disabled={pause.isPending} className={ghost}>Pause</button>}
          {admin && s.status === "paused" && <button onClick={() => resume.mutate()} disabled={resume.isPending} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>Resume</button>}
          {admin && s.status !== "ended" && <button onClick={() => setConfirmEnd(true)} className="text-sm text-slate-500 hover:text-red-700">End</button>}
          {admin && s.status === "ended" && <button onClick={() => remove.mutate()} disabled={remove.isPending} className="text-sm text-slate-500 hover:text-red-700">Delete</button>}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-700">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-white p-4 lg:grid-cols-3">
              <div className="lg:col-span-2"><CrmField label="Schedule name"><input value={name} onChange={(e) => touch(setName)(e.target.value)} className={input} /></CrmField></div>
              <CrmField label="Type">
                <select value={kind} onChange={(e) => touch(setKind)(e.target.value as ScheduleKind)} className={input}>
                  <option value="recurring">Recurring invoice</option>
                  <option value="subscription">Subscription plan</option>
                </select>
              </CrmField>
              <div className="lg:col-span-3"><CrmField label="Invoice title (each generated invoice)"><input value={title} onChange={(e) => touch(setTitle)(e.target.value)} className={input} /></CrmField></div>
              <CrmField label="Company">
                <select value={companyId} onChange={(e) => { touch(setCompanyId)(e.target.value); setContactId(""); }} className={input}>
                  <option value="">—</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </CrmField>
              <CrmField label="Contact">
                <select value={contactId} onChange={(e) => touch(setContactId)(e.target.value)} disabled={!companyId} className={input}>
                  <option value="">—</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
                </select>
              </CrmField>
              <CrmField label="Project">
                <select value={projectId} onChange={(e) => touch(setProjectId)(e.target.value)} className={input}>
                  <option value="">—</option>
                  {projects.filter((p) => p.kind !== "internal").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </CrmField>
              <CrmField label="Currency"><input value={currency} maxLength={3} onChange={(e) => touch(setCurrency)(e.target.value.toUpperCase())} className={input} /></CrmField>
              <CrmField label="Due (days after issue)"><input type="number" min="0" max="365" value={dueDays} onChange={(e) => touch(setDueDays)(e.target.value)} className={input} /></CrmField>
              <CrmField label="Discount (%)"><input type="number" min="0" max="100" step="0.01" value={discount} onChange={(e) => touch(setDiscount)(e.target.value)} className={input} /></CrmField>
              <CrmField label="Tax rate (%)"><input type="number" min="0" max="100" step="0.01" value={taxRate} onChange={(e) => touch(setTaxRate)(e.target.value)} className={input} /></CrmField>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Line items on every invoice</th>
                    <th className="w-24 px-2 py-2 text-right font-medium">Qty</th>
                    <th className="w-32 px-2 py-2 text-right font-medium">Unit price</th>
                    <th className="w-32 px-4 py-2 text-right font-medium">Amount</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={idx} className="border-t border-border">
                      <td className="px-2 py-1"><input value={it.description} onChange={(e) => setItem(idx, { description: e.target.value })} placeholder={kind === "subscription" ? "Growth plan — monthly fee" : "Retainer — 20 hours"} className="w-full bg-transparent px-2 py-1.5 text-sm outline-none focus:bg-indigo-50" /></td>
                      <td className="px-2 py-1"><input type="number" min="0" step="0.5" value={it.quantity} onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })} className="w-full bg-transparent px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:bg-indigo-50" /></td>
                      <td className="px-2 py-1"><input type="number" step="0.01" value={it.unitPrice} onChange={(e) => setItem(idx, { unitPrice: Number(e.target.value) })} className="w-full bg-transparent px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:bg-indigo-50" /></td>
                      <td className="px-4 py-1 text-right tabular-nums text-slate-800">{fmtMoney(it.quantity * it.unitPrice, currency)}</td>
                      <td className="px-2 text-center"><button onClick={() => { setItems((l) => l.filter((_, i) => i !== idx)); setDirty(true); }} className="text-slate-300 hover:text-red-500">✕</button></td>
                    </tr>
                  ))}
                  {!items.length && <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No line items yet — nothing will be generated until there is at least one.</td></tr>}
                </tbody>
              </table>
              <div className="border-t border-border px-4 py-2">
                <button onClick={() => { setItems((l) => [...l, { description: "", quantity: 1, unitPrice: 0 }]); setDirty(true); }} className="text-sm font-medium text-indigo-600 hover:text-indigo-700">+ Add line</button>
              </div>
              <div className="border-t border-border bg-[#fbfbfa] px-4 py-3">
                <div className="ml-auto w-72 space-y-1 text-sm">
                  <div className="flex justify-between text-slate-600"><span>Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal, currency)}</span></div>
                  {discountAmt > 0 && <div className="flex justify-between text-slate-600"><span>Discount ({Number(discount) || 0}%)</span><span className="tabular-nums">−{fmtMoney(discountAmt, currency)}</span></div>}
                  <div className="flex justify-between text-slate-600"><span>Tax ({Number(taxRate) || 0}%)</span><span className="tabular-nums">{fmtMoney(tax, currency)}</span></div>
                  <div className="flex justify-between border-t border-border pt-1 font-semibold text-slate-900"><span>Each invoice</span><span className="tabular-nums">{fmtMoney(total, currency)}</span></div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-white p-4">
              <CrmField label="Notes / payment instructions (copied onto every invoice)">
                <textarea value={notes} onChange={(e) => touch(setNotes)(e.target.value)} rows={3} className={input + " resize-none"} placeholder="Bank details, payment terms…" />
              </CrmField>
            </div>

            <section className="rounded-lg border border-border bg-white">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Generated invoices</h2>
                <span className="text-xs text-muted-foreground">{s.invoices.length}</span>
              </div>
              {s.invoices.length ? (
                <table className="w-full text-sm">
                  <tbody>
                    {s.invoices.map((inv) => (
                      <tr key={inv.id} className="border-t border-border first:border-t-0 hover:bg-[#fbfbfa]">
                        <td className="px-4 py-2"><Link to="/finance/invoices/$invoiceId" params={{ invoiceId: inv.id }} className="font-medium text-indigo-600 hover:text-indigo-700">{inv.number}</Link></td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">issued {fmtShortDate(inv.issueDate)}{inv.dueDate ? ` · due ${fmtShortDate(inv.dueDate)}` : ""}</td>
                        <td className="px-4 py-2"><InvoiceChip inv={inv} /></td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-800">{fmtMoney(inv.total, inv.currency)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">{inv.status === "paid" ? "paid" : inv.status === "void" ? "—" : `${fmtMoney(inv.balanceDue, inv.currency)} due`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="px-4 py-5 text-sm text-muted-foreground">Nothing generated yet. The first invoice is created on {fmtShortDate(s.startsAt)}{admin ? ", or press Run now" : ""}.</p>
              )}
            </section>
          </div>

          <aside className="space-y-4">
            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cadence</h2>
              <div className="mt-3 space-y-3">
                <CrmField label="Repeats">
                  <select value={frequency} onChange={(e) => touch(setFrequency)(e.target.value as ScheduleFrequency)} className={input}>
                    {FREQUENCIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </CrmField>
                {frequency === "custom" && (
                  <div className="flex gap-2">
                    <CrmField label="Every"><input type="number" min="1" max="52" value={every} onChange={(e) => touch(setEvery)(e.target.value)} className={input} /></CrmField>
                    <CrmField label="Unit">
                      <select value={unit} onChange={(e) => touch(setUnit)(e.target.value as ScheduleUnit)} className={input}>
                        <option value="week">weeks</option><option value="month">months</option><option value="year">years</option>
                      </select>
                    </CrmField>
                  </div>
                )}
                <CrmField label={s.occurrences ? "Started on" : "First invoice on"}><input type="date" value={startsAt} onChange={(e) => touch(setStartsAt)(e.target.value)} className={input} /></CrmField>
                <CrmField label="Ends on (optional)"><input type="date" value={endsAt} onChange={(e) => touch(setEndsAt)(e.target.value)} className={input} /></CrmField>
                <CrmField label="Stop after N invoices (optional)"><input type="number" min="1" value={maxOcc} onChange={(e) => touch(setMaxOcc)(e.target.value)} className={input} placeholder="unlimited" /></CrmField>
                <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs">
                  <input type="checkbox" checked={autoSend} onChange={(e) => touch(setAutoSend)(e.target.checked)} className="mt-0.5" />
                  <span><span className="font-medium text-slate-800">Send automatically</span><br /><span className="text-muted-foreground">Off = each invoice waits as a draft in your inbox.</span></span>
                </label>
              </div>
            </section>
            <section className="rounded-lg border border-border bg-white p-4 text-xs text-muted-foreground">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h2>
              <dl className="mt-2 space-y-1">
                <div className="flex justify-between"><dt>Created</dt><dd className="text-slate-700">{fmtShortDate(s.createdAt)}{s.createdBy ? ` by ${s.createdBy.name}` : ""}</dd></div>
                {s.lastRunAt && <div className="flex justify-between"><dt>Last run</dt><dd className="text-slate-700">{fmtShortDate(s.lastRunAt)}</dd></div>}
                {s.pausedAt && s.status === "paused" && <div className="flex justify-between"><dt>Paused</dt><dd className="text-slate-700">{fmtShortDate(s.pausedAt)}</dd></div>}
                {s.endedAt && <div className="flex justify-between"><dt>Ended</dt><dd className="text-slate-700">{fmtShortDate(s.endedAt)}</dd></div>}
              </dl>
              <p className="mt-3 text-[11px] leading-relaxed">Runs are checked every few minutes. Resuming never back-fills missed runs. The day of month is kept (the 31st bills on the last day of shorter months).</p>
            </section>
          </aside>
        </div>
      </div>

      {confirmEnd && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setConfirmEnd(false)} />
          <div className="fixed left-1/2 top-1/2 z-50 w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">End this schedule?</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">No more invoices will be generated. Invoices already created are untouched. You can relax the end date or count later to bring it back.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmEnd(false)} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
              <button type="button" onClick={() => end.mutate()} disabled={end.isPending} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">End schedule</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
