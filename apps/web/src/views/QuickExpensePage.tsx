import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { cn } from "../lib/utils.js";

/**
 * Row 132: log a cost from the phone while it is still in your hand — amount,
 * where, which project, snap the receipt. One column, big targets, the camera
 * opens straight from the button. Same API as the desktop ledger.
 */
export function QuickExpensePage() {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const { data: categories = [] } = useQuery({ queryKey: ["expense-categories"], queryFn: api.getExpenseCategories });
  const { data: mine = [] } = useQuery({ queryKey: ["expenses", "mine"], queryFn: () => api.getExpenses({ mine: "1" }) });

  const [amount, setAmount] = useState("");
  const [vendor, setVendor] = useState("");
  const [projectId, setProjectId] = useState("");
  const [category, setCategory] = useState("");
  const [billable, setBillable] = useState(true);
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Projects you logged against recently come first.
  const choices = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string; color: string; hint?: string }[] = [];
    for (const e of mine) {
      if (!e.projectId || seen.has(e.projectId)) continue;
      const p = projects.find((x) => x.id === e.projectId);
      if (!p) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: p.name, color: p.color, hint: "recent" });
    }
    for (const p of projects.filter((p) => p.status === "active" && p.kind !== "internal")) if (!seen.has(p.id)) out.push({ id: p.id, name: p.name, color: p.color });
    return out;
  }, [mine, projects]);

  const pick = (f: File | null) => {
    setPhoto(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f && f.type.startsWith("image/") ? URL.createObjectURL(f) : null);
  };

  const save = useMutation({
    mutationFn: async () => {
      const e = await api.createExpense({ vendor: vendor.trim(), amount: Number(amount), projectId: projectId || null, ...(category ? { category } : {}), billable, description: note.trim() || null });
      if (photo) await api.uploadFile(photo, { expenseId: e.id });
      return e;
    },
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["expense-totals"] });
      setToast(`${fmtMoney(e.amount, e.currency)} at ${e.vendor} logged${photo ? " with receipt" : ""} ✓`);
      setTimeout(() => setToast(null), 3000);
      setAmount("");
      setVendor("");
      setNote("");
      pick(null);
      if (fileRef.current) fileRef.current.value = "";
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const ready = Number(amount) > 0 && vendor.trim().length > 0;
  const chip = "flex min-h-[44px] items-center justify-center rounded-xl border px-3 text-sm font-medium transition active:scale-[0.98]";
  const field = "min-h-[48px] w-full rounded-xl border border-border bg-white px-3 text-base text-slate-900 outline-none focus:border-indigo-500";

  function submit(e: FormEvent) {
    e.preventDefault();
    if (ready && !save.isPending) save.mutate();
  }

  return (
    <form onSubmit={submit} className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" data-testid="quick-expense">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Log an expense</h1>
          <p className="text-xs text-muted-foreground">Snap the receipt while you have it.</p>
        </div>
        <Link to="/finance/expenses" className="text-xs font-medium text-indigo-600">All expenses →</Link>
      </header>

      <section>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">1 · How much, where</p>
        <div className="grid grid-cols-[1fr_1.6fr] gap-2">
          <input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={cn(field, "text-lg font-semibold tabular-nums")} aria-label="Amount" autoFocus />
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor (Uber, Staples…)" className={field} aria-label="Vendor" />
        </div>
      </section>

      <section>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">2 · Which project</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setProjectId("")} className={cn(chip, projectId === "" ? "border-indigo-500 bg-indigo-50 text-indigo-900" : "border-border bg-white text-slate-700")}>No project</button>
          {choices.map((c) => (
            <button key={c.id} type="button" onClick={() => setProjectId(c.id)} className={cn(chip, "justify-start gap-2 text-left", projectId === c.id ? "border-indigo-500 bg-indigo-50 text-indigo-900" : "border-border bg-white text-slate-700")}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.hint && <span className="text-[10px] font-normal text-muted-foreground">{c.hint}</span>}
            </button>
          ))}
        </div>
      </section>

      <section>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">3 · Receipt</p>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} data-testid="receipt-input" />
        {preview ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-white p-2">
            <img src={preview} alt="Receipt" className="h-16 w-16 rounded-lg object-cover" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-slate-800">{photo?.name}</p>
              <p className="text-xs text-muted-foreground">{photo ? `${Math.round(photo.size / 1024)} KB` : ""}</p>
            </div>
            <button type="button" onClick={() => { pick(null); if (fileRef.current) fileRef.current.value = ""; }} className="rounded-lg px-2 py-1 text-xs text-slate-500">Remove</button>
          </div>
        ) : photo ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-white p-3 text-sm text-slate-800">📄 {photo.name}<button type="button" onClick={() => pick(null)} className="ml-auto text-xs text-slate-500">Remove</button></div>
        ) : (
          <button type="button" onClick={() => fileRef.current?.click()} className={cn(chip, "w-full gap-2 border-dashed border-border bg-white text-slate-700")}>
            📷 Take a photo of the receipt
          </button>
        )}
      </section>

      <section className="grid grid-cols-2 gap-2">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={field} aria-label="Category">
          <option value="">Category: guess</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button type="button" onClick={() => setBillable((v) => !v)} className={cn(chip, billable ? "border-emerald-500 bg-emerald-50 text-emerald-900" : "border-border bg-white text-slate-700")} data-testid="billable-toggle">
          {billable ? "✓ Bill to client" : "Not billable"}
        </button>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={cn(field, "col-span-2")} aria-label="Note" />
      </section>

      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={!ready || save.isPending} className="flex min-h-[52px] w-full items-center justify-center rounded-xl bg-indigo-600 text-base font-semibold text-white active:scale-[0.98] disabled:opacity-50" data-testid="save-expense">
        {save.isPending ? "Saving…" : ready ? `Log ${fmtMoney(Number(amount))}${photo ? " + receipt" : ""}` : "Log expense"}
      </button>
      {toast && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-center text-sm font-medium text-emerald-800">{toast}</p>}

      {mine.length > 0 && (
        <section className="pb-6">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Yours, latest first</p>
          <ul className="divide-y divide-border rounded-xl border border-border bg-white">
            {mine.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="w-14 text-xs text-muted-foreground">{fmtShortDate(e.date)}</span>
                <span className="min-w-0 flex-1 truncate text-slate-800">{e.vendor}{e.project ? <span className="text-muted-foreground"> · {e.project.name}</span> : null}</span>
                {e.receiptUrl && <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="text-xs" title="Receipt">🧾</a>}
                <span className="tabular-nums text-slate-900">{fmtMoney(e.amount, e.currency)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </form>
  );
}
