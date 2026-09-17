import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type InvoicingSettings as Settings } from "../lib/api.js";
import { CrmField, input } from "../views/CompaniesPage.js";
import { cn } from "../lib/utils.js";

/**
 * Row 139: number format, terms, tax and review policy — set once, applied
 * to every new invoice. Branding (colour, logo, footer) lives under Branding.
 */
export function InvoicingSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["invoicing-settings"], queryFn: api.getInvoicingSettings });
  const [f, setF] = useState<Settings | null>(null);
  const [nextNumber, setNextNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) {
      setF(data);
      setNextNumber(data.nextNumber != null ? String(data.nextNumber) : "");
    }
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.updateInvoicingSettings({ ...f!, nextNumber: nextNumber ? Number(nextNumber) : null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["invoicing-settings"] });
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (!f) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const dirty = JSON.stringify({ ...f, nextNumber: nextNumber ? Number(nextNumber) : null }) !== JSON.stringify(data);
  const sample = `${f.prefix}${String(Number(nextNumber) || 1).padStart(f.padding, "0")}`;
  return (
    <div className="max-w-2xl" data-testid="invoicing-settings">
      <h1 className="text-lg font-semibold text-slate-900">Invoicing</h1>
      <p className="mt-1 text-sm text-muted-foreground">Number format, payment terms, tax and who may issue — set once here. Colour, logo and footer are under Branding.</p>
      <section className="mt-4 rounded-lg border border-border bg-white p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Numbering</h2>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <CrmField label="Prefix"><input value={f.prefix} disabled={!canEdit} onChange={(e) => setF({ ...f, prefix: e.target.value })} className={input} /></CrmField>
          <CrmField label="Digits"><input type="number" min="1" max="8" value={f.padding} disabled={!canEdit} onChange={(e) => setF({ ...f, padding: Number(e.target.value) || 4 })} className={input} /></CrmField>
          <CrmField label="Next number (optional)"><input type="number" min="1" value={nextNumber} disabled={!canEdit} onChange={(e) => setNextNumber(e.target.value)} className={input} placeholder="continue" /></CrmField>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Next invoice looks like <code className="rounded bg-slate-100 px-1">{sample}</code>. Revisions keep their number and add a version (v2, v3…).</p>
      </section>
      <section className="mt-4 rounded-lg border border-border bg-white p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Defaults for new invoices</h2>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <CrmField label="Due in (days)"><input type="number" min="0" max="365" value={f.defaultDueDays} disabled={!canEdit} onChange={(e) => setF({ ...f, defaultDueDays: Number(e.target.value) || 0 })} className={input} /></CrmField>
          <CrmField label="Tax rate (%)"><input type="number" min="0" max="100" step="0.01" value={f.defaultTaxRate} disabled={!canEdit} onChange={(e) => setF({ ...f, defaultTaxRate: Number(e.target.value) || 0 })} className={input} /></CrmField>
          <CrmField label="Currency"><input value={f.defaultCurrency} maxLength={3} disabled={!canEdit} onChange={(e) => setF({ ...f, defaultCurrency: e.target.value.toUpperCase() })} className={input} /></CrmField>
          <div className="col-span-3"><CrmField label="Payment terms / notes"><textarea value={f.defaultNotes} rows={3} disabled={!canEdit} onChange={(e) => setF({ ...f, defaultNotes: e.target.value })} className={cn(input, "resize-none")} placeholder="Bank details, payment terms, thank-you note…" /></CrmField></div>
        </div>
      </section>
      <section className="mt-4 rounded-lg border border-border bg-white p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Review & issue</h2>
        <p className="mt-2 text-xs text-muted-foreground">Anyone can draft. Only owners and admins issue (send). Members submit a draft for review; the admins get an inbox card and approve or return it. Once issued, an invoice never changes — a revision creates the next version and keeps the old one.</p>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" checked={f.requireReview} disabled={!canEdit} onChange={(e) => setF({ ...f, requireReview: e.target.checked })} />
          Admins must also go through review before issuing (draft → review → issued for everyone)
        </label>
      </section>
      <section className="mt-4 rounded-lg border border-border bg-white p-4" data-testid="reminder-settings">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overdue reminders (row 154)</h2>
        <p className="mt-2 text-xs text-muted-foreground">Emails the client&apos;s billing contact at each step after the due date — each step once, the highest due step only, never a burst. Pause per invoice from the invoice page.</p>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" checked={f.remindersEnabled ?? true} disabled={!canEdit} onChange={(e) => setF({ ...f, remindersEnabled: e.target.checked })} />
          Send reminders automatically
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <CrmField label="Days overdue (comma-separated)"><input value={(f.reminderDays ?? [3, 14, 30]).join(", ")} disabled={!canEdit} onChange={(e) => setF({ ...f, reminderDays: e.target.value.split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0) })} className={input} placeholder="3, 14, 30" /></CrmField>
          <CrmField label="Note added to every reminder"><input value={f.reminderNote ?? ""} disabled={!canEdit} onChange={(e) => setF({ ...f, reminderNote: e.target.value })} className={input} placeholder="Bank details, who to call…" /></CrmField>
        </div>
      </section>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {canEdit && dirty && (
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="mt-4 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save"}
        </button>
      )}
    </div>
  );
}
