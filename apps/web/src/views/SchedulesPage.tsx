import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type InvoiceSchedule, type ScheduleFrequency, type ScheduleKind, type ScheduleStatus } from "../lib/api.js";
import { fmtMoney, fmtShortDate, isoDay } from "../lib/format.js";
import { CrmField, input } from "./CompaniesPage.js";
import { useEscape } from "../lib/useEscape.js";
import { cn } from "../lib/utils.js";

export const SCHEDULE_STATUS: Record<ScheduleStatus, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  paused: { label: "Paused", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  ended: { label: "Ended", cls: "bg-slate-100 text-slate-500 border-slate-200" },
};

export const FREQUENCIES: { key: ScheduleFrequency; label: string }[] = [
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "yearly", label: "Yearly" },
  { key: "custom", label: "Custom…" },
];

export const PRESET: Record<Exclude<ScheduleFrequency, "custom">, { every: number; unit: "week" | "month" | "year" }> = {
  weekly: { every: 1, unit: "week" },
  monthly: { every: 1, unit: "month" },
  quarterly: { every: 3, unit: "month" },
  yearly: { every: 1, unit: "year" },
};

/** "Every 2 weeks", "Monthly". */
export function cadenceLabel(s: Pick<InvoiceSchedule, "every" | "unit" | "frequency">) {
  if (s.frequency !== "custom") return FREQUENCIES.find((f) => f.key === s.frequency)!.label;
  return `Every ${s.every} ${s.unit}${s.every === 1 ? "" : "s"}`;
}

/** Row 157: every billing schedule, with what fires next. */
export function SchedulesPage() {
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"all" | ScheduleStatus>("all");
  const { data: schedules = [], isLoading } = useQuery({ queryKey: ["schedules", filter], queryFn: () => api.getSchedules({ status: filter }) });
  const { data: totals } = useQuery({ queryKey: ["schedule-totals"], queryFn: api.getScheduleTotals });
  const monthly = schedules.filter((s) => s.status === "active").reduce((a, s) => a + perMonth(s), 0);

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Recurring & subscriptions</h1>
        <span className="text-xs text-muted-foreground">
          {totals?.active ?? 0} active · ≈ <span className="font-medium text-slate-700">{fmtMoney(monthly)}</span>/month
          {totals?.nextRunAt && <> · next {fmtShortDate(totals.nextRunAt)}</>} · {totals?.generated ?? 0} invoices generated
        </span>
        <button onClick={() => setCreating(true)} className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New schedule
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <AwaitingReview />
        <div className="mb-3 flex flex-wrap gap-1">
          {(["all", "active", "paused", "ended"] as const).map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={cn("rounded-full border px-3 py-1 text-xs font-medium capitalize transition", filter === k ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:bg-muted")}>
              {k}
            </button>
          ))}
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : schedules.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">Client</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-left font-medium">Cadence</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-right font-medium">Next run</th>
                  <th className="px-4 py-2 text-right font-medium">Generated</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className="border-t border-border hover:bg-[#fbfbfa]">
                    <td className="px-4 py-2.5">
                      <Link to="/finance/recurring/$scheduleId" params={{ scheduleId: s.id }} className="font-medium text-indigo-600 hover:text-indigo-700">{s.name}</Link>
                      {s.lastError && <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700" title={s.lastError}>last run failed</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{s.company?.name ?? s.contact?.name ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600">{s.kind === "subscription" ? "Subscription" : "Recurring"}</td>
                    <td className="px-4 py-2.5 text-slate-600">{cadenceLabel(s)}{s.autoSend ? <span className="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">auto-send</span> : s.reviewer ? <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-700" title="Reviews and sends each draft">→ {s.reviewer.name}</span> : null}</td>
                    <td className="px-4 py-2.5"><span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", SCHEDULE_STATUS[s.status].cls)}>{SCHEDULE_STATUS[s.status].label}</span></td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-800">{fmtMoney(s.amount, s.currency)}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{s.status === "active" && s.nextRunAt ? fmtShortDate(s.nextRunAt) : "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{s.occurrences}{s.maxOccurrences ? ` / ${s.maxOccurrences}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">🔁</span>
            <p className="text-sm text-muted-foreground">{filter === "all" ? "No recurring invoices yet. Retainers and subscriptions live here." : "Nothing here."}</p>
          </div>
        )}
      </div>
      {creating && <NewScheduleDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function perMonth(s: InvoiceSchedule) {
  const months = s.unit === "week" ? (s.every * 7) / 30.4375 : s.unit === "year" ? s.every * 12 : s.every;
  return s.amount / months;
}

/** New schedule: from an existing invoice (copies lines + client) or blank. Details are edited on the next page. */
/** Row 138: drafts a schedule generated that nobody has sent yet — issue right here. */
function AwaitingReview() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["awaiting-review"], queryFn: api.getAwaitingReview });
  const issue = useMutation({
    mutationFn: (id: string) => api.issueScheduledInvoice(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["awaiting-review"] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  if (!data.length) return null;
  return (
    <section className="mb-4 rounded-lg border border-amber-200 bg-amber-50/50 p-3" data-testid="awaiting-review">
      <p className="text-xs font-semibold text-slate-800">{data.length} generated draft{data.length === 1 ? "" : "s"} waiting to be sent</p>
      <ul className="mt-2 space-y-1">
        {data.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: d.id }} className="font-medium text-slate-900 hover:underline">{d.number}</Link>
            <span className="text-muted-foreground">{d.scheduleName} · {fmtMoney(d.total, d.currency)}</span>
            <span className={cn("rounded px-1.5 py-0.5 text-[10px]", d.ageDays >= 2 ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600")}>{d.ageDays === 0 ? "today" : `${d.ageDays} day${d.ageDays === 1 ? "" : "s"} old`}</span>
            <button type="button" disabled={issue.isPending} onClick={() => issue.mutate(d.id)} className="ml-auto rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Send now</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NewScheduleDialog({ onClose, fromInvoiceId, companyId: presetCompany }: { onClose: () => void; fromInvoiceId?: string; companyId?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEscape(onClose);
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: invoices = [] } = useQuery({ queryKey: ["invoices", "all"], queryFn: () => api.getInvoices({ status: "all" }), enabled: !fromInvoiceId });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("recurring");
  const [companyId, setCompanyId] = useState(presetCompany ?? "");
  const [sourceId, setSourceId] = useState(fromInvoiceId ?? "");
  const [frequency, setFrequency] = useState<ScheduleFrequency>("monthly");
  const [every, setEvery] = useState("2");
  const [unit, setUnit] = useState<"week" | "month" | "year">("week");
  const [startsAt, setStartsAt] = useState(isoDay(new Date()));
  const [autoSend, setAutoSend] = useState(false);
  const [reviewerId, setReviewerId] = useState("");
  const { data: reviewers = [] } = useQuery({ queryKey: ["schedule-reviewers"], queryFn: api.getScheduleReviewers });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createSchedule({
        name: name.trim() || undefined,
        kind,
        companyId: companyId || undefined,
        fromInvoiceId: sourceId || null,
        ...(frequency === "custom" ? { every: Number(every) || 1, unit } : PRESET[frequency]),
        startsAt: new Date(startsAt).toISOString(),
        autoSend,
        reviewerId: reviewerId || null,
      }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: ["schedule-totals"] });
      onClose();
      navigate({ to: "/finance/recurring/$scheduleId", params: { scheduleId: s.id } });
    },
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() || sourceId) create.mutate();
  }
  const src = invoices.find((i) => i.id === sourceId);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">New billing schedule</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">An invoice is generated on every run. Lines, terms and limits can be edited next.</p>
        <div className="mt-4 flex gap-1 rounded-md bg-muted p-1 text-xs font-medium">
          {([["recurring", "Recurring invoice"], ["subscription", "Subscription plan"]] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={cn("flex-1 rounded px-2 py-1 transition", kind === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>{label}</button>
          ))}
        </div>
        <div className="mt-4 space-y-3">
          {!fromInvoiceId && (
            <CrmField label="Start from an existing invoice (optional)">
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={input}>
                <option value="">Blank — I'll add lines next</option>
                {invoices.filter((i) => i.status !== "void" && (!companyId || i.company?.id === companyId)).map((i) => <option key={i.id} value={i.id}>{i.number} · {i.title} · {fmtMoney(i.total, i.currency)}</option>)}
              </select>
            </CrmField>
          )}
          <CrmField label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder={src ? src.title : kind === "subscription" ? "Growth plan — Acme" : "Monthly retainer — Acme"} /></CrmField>
          {!sourceId && (
            <CrmField label="Company">
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={input}>
                <option value="">No company</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </CrmField>
          )}
          <div className="grid grid-cols-2 gap-3">
            <CrmField label="Repeats">
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)} className={input}>
                {FREQUENCIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </CrmField>
            <CrmField label="First invoice on"><input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={input} /></CrmField>
            {frequency === "custom" && (
              <div className="col-span-2 flex items-end gap-2">
                <CrmField label="Every"><input type="number" min="1" max="52" value={every} onChange={(e) => setEvery(e.target.value)} className={input} /></CrmField>
                <CrmField label="Unit">
                  <select value={unit} onChange={(e) => setUnit(e.target.value as "week" | "month" | "year")} className={input}>
                    <option value="week">weeks</option><option value="month">months</option><option value="year">years</option>
                  </select>
                </CrmField>
              </div>
            )}
          </div>
          <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} className="mt-0.5" />
            <span><span className="font-medium text-slate-800">Send automatically</span><br /><span className="text-muted-foreground">Each invoice goes out (client link live) the moment it is generated. Off = a draft lands in the reviewer&apos;s inbox to check and send.</span></span>
          </label>
          {!autoSend && (
            <CrmField label="Reviewer who issues each draft">
              <select value={reviewerId} onChange={(e) => setReviewerId(e.target.value)} className={input} data-testid="reviewer-select">
                <option value="">Whoever creates the schedule</option>
                {reviewers.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.role}</option>)}
              </select>
            </CrmField>
          )}
        </div>
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={(!name.trim() && !sourceId) || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create schedule"}
          </button>
        </div>
      </form>
    </>
  );
}
