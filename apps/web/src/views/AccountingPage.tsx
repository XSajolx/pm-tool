import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type AccountingLink, type AccountingOverview, type AccountingProviderKey, type AccountingSettings, type IntegrationStatus } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

const LABEL: Record<AccountingProviderKey, string> = { quickbooks: "QuickBooks Online", xero: "Xero", demo: "Demo ledger" };
const STATUS: Record<AccountingLink["status"] | "pending", { label: string; cls: string }> = {
  synced: { label: "Synced", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  drifted: { label: "Edited in ledger", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  conflict: { label: "Conflict", cls: "bg-red-50 text-red-700 border-red-200" },
  error: { label: "Error", cls: "bg-red-50 text-red-700 border-red-200" },
  pending: { label: "Not synced yet", cls: "bg-slate-100 text-slate-600 border-slate-200" },
};
const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

/**
 * Row 131: Finance › Accounting. Pick the ledger, push invoices + payments,
 * and — the point of the page — see every record whose ledger copy changed
 * so a person decides which side wins. Nothing is ever overwritten silently.
 */
export function AccountingPage() {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["accounting"], queryFn: api.getAccounting, enabled: admin, refetchInterval: (q) => (q.state.data?.running ? 2000 : false) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["accounting"] });

  // Back from the QuickBooks / Xero consent screen.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) setNotice({ kind: "ok", text: `${LABEL[q.get("connected") as AccountingProviderKey] ?? q.get("connected")} connected. Choose it below and run a sync.` });
    if (q.get("error")) setNotice({ kind: "error", text: q.get("error")! });
    if (q.get("connected") || q.get("error")) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const save = useMutation({
    mutationFn: (patch: Partial<AccountingSettings>) => api.updateAccountingSettings(patch),
    onSuccess: () => refresh(),
    onError: (e) => setNotice({ kind: "error", text: errorMessage(e) }),
  });
  const sync = useMutation({
    mutationFn: () => api.syncAccounting(),
    onSuccess: (r) => {
      setNotice({ kind: r.errors ? "error" : "ok", text: `${r.created} created · ${r.updated} updated · ${r.unchanged} unchanged · ${r.conflicts} need attention · ${r.errors} errors${r.message ? ` — ${r.message}` : ""}` });
      refresh();
    },
    onError: (e) => setNotice({ kind: "error", text: errorMessage(e) }),
  });
  const resolve = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: "ours" | "theirs" | "retry" }) => api.resolveAccountingLink(id, choice),
    onSuccess: (ov) => qc.setQueryData(["accounting"], ov),
    onError: (e) => setNotice({ kind: "error", text: errorMessage(e) }),
  });
  const start = useMutation({
    mutationFn: (p: "quickbooks" | "xero") => api.startIntegration(p),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e) => setNotice({ kind: "error", text: errorMessage(e) }),
  });
  const disconnect = useMutation({ mutationFn: (p: "quickbooks" | "xero") => api.disconnectIntegration(p), onSuccess: refresh, onError: (e) => setNotice({ kind: "error", text: errorMessage(e) }) });

  if (!admin) return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">Accounting sync is for owners and admins.</div>;

  const s = data?.settings;
  const providerLabel = s?.provider ? LABEL[s.provider] : null;
  const lastRun = data?.runs[0];

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden" data-testid="accounting-page">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Accounting sync</h1>
        {providerLabel && (
          <span className="text-xs text-muted-foreground">
            Pushing to <b className="text-slate-700">{providerLabel}</b>
            {lastRun ? ` · last run ${fmtWhen(lastRun.finishedAt ?? lastRun.startedAt)}` : " · never run"}
            {s?.autoSync ? " · auto every hour" : " · manual only"}
          </span>
        )}
        <button
          type="button"
          disabled={!s?.provider || sync.isPending || data?.running}
          onClick={() => sync.mutate()}
          className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          data-testid="sync-now"
        >
          {sync.isPending || data?.running ? "Syncing…" : "Sync now"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading || !data || !s ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="mx-auto max-w-6xl space-y-5">
            {notice && (
              <p className={cn("rounded-md border px-3 py-2 text-sm", notice.kind === "ok" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-700")} data-testid="accounting-notice">
                {notice.text}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Tile label="Synced" value={String(data.counts.synced)} tone="text-emerald-700" />
              <Tile label="Waiting to push" value={String(data.counts.pending)} hint="issued, not in the ledger yet" />
              <Tile label="Edited in ledger" value={String(data.counts.drifted)} tone={data.counts.drifted ? "text-amber-700" : undefined} />
              <Tile label="Conflicts" value={String(data.counts.conflicts)} tone={data.counts.conflicts ? "text-red-700" : undefined} hint="changed on both sides" />
              <Tile label="Errors" value={String(data.counts.errors)} tone={data.counts.errors ? "text-red-700" : undefined} />
            </div>

            {data.attention.length > 0 && (
              <section className="rounded-lg border border-amber-200 bg-amber-50/40 p-4" data-testid="attention">
                <h2 className="text-sm font-semibold text-slate-900">Needs a decision</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">These differ between here and {providerLabel ?? "the ledger"}. Nothing was overwritten — pick which version to keep.</p>
                <ul className="mt-3 space-y-3">
                  {data.attention.map((l) => (
                    <AttentionRow key={l.id} link={l} provider={providerLabel ?? "the ledger"} busy={resolve.isPending} onResolve={(choice) => resolve.mutate({ id: l.id, choice })} />
                  ))}
                </ul>
              </section>
            )}

            <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
              <ProviderPicker data={data} onPick={(p) => save.mutate({ provider: p })} onStart={(p) => start.mutate(p)} onDisconnect={(p) => disconnect.mutate(p)} busy={save.isPending || start.isPending} />
              <Options settings={s} onSave={(patch) => save.mutate(patch)} busy={save.isPending} />
            </div>

            <section className="rounded-lg border border-border bg-white">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold text-slate-900">Linked records</h2>
                <span className="text-xs text-muted-foreground">{data.links.length} in {providerLabel ?? "the ledger"}</span>
              </div>
              {data.links.length ? (
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 font-medium">Here</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">In the ledger</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium text-right">Last synced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.links.slice(0, 200).map((l) => (
                      <tr key={l.id} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-2 text-slate-800">
                          {l.invoice ? (
                            <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: l.invoice.id }} className="font-medium hover:underline">
                              {l.invoice.number} <span className="font-normal text-muted-foreground">· {l.invoice.title}</span>
                            </Link>
                          ) : (
                            l.remoteLabel ?? l.entityId.slice(0, 8)
                          )}
                        </td>
                        <td className="px-3 py-2 capitalize text-muted-foreground">{l.entityType === "company" ? "customer" : l.entityType}</td>
                        <td className="px-3 py-2 text-slate-700">
                          {l.remoteUrl ? <a href={l.remoteUrl} target="_blank" rel="noreferrer" className="hover:underline">{l.remoteLabel ?? l.remoteId} ↗</a> : <span title={l.remoteId}>{l.remoteLabel ?? l.remoteId}</span>}
                        </td>
                        <td className="px-3 py-2"><Chip status={l.status} /></td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmtWhen(l.syncedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">{s.provider ? "Nothing pushed yet — run a sync." : "Choose a provider to start."}</p>
              )}
            </section>

            <section className="rounded-lg border border-border bg-white">
              <div className="border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-900">Recent runs</h2></div>
              {data.runs.length ? (
                <ul className="divide-y divide-border">
                  {data.runs.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
                      <span className="w-32 text-slate-700">{fmtWhen(r.startedAt)}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-600">{r.trigger}</span>
                      <span className="text-muted-foreground">{r.startedBy ? `by ${r.startedBy.name}` : "scheduled"}</span>
                      <span className="ml-auto tabular-nums text-slate-700">{r.created} created · {r.updated} updated · {r.unchanged} unchanged · <span className={r.conflicts ? "text-amber-700" : ""}>{r.conflicts} flagged</span> · <span className={r.errors ? "text-red-700" : ""}>{r.errors} errors</span></span>
                      {r.message && <span className="w-full text-red-700">{r.message}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">No runs yet.</p>
              )}
            </section>

            {s.provider === "demo" && <DemoLedger onChanged={refresh} />}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- pieces ---------------- */

function Chip({ status }: { status: AccountingLink["status"] | "pending" }) {
  const st = STATUS[status];
  return <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>;
}
export { Chip as AccountingChip };

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums text-slate-900", tone)}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function AttentionRow({ link, provider, busy, onResolve }: { link: AccountingLink; provider: string; busy: boolean; onResolve: (c: "ours" | "theirs" | "retry") => void }) {
  const c = link.conflict;
  const money = (v: unknown) => (typeof v === "number" ? fmtMoney(v) : "—");
  return (
    <li className="rounded-md border border-border bg-white p-3" data-testid={`attention-${link.status}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip status={link.status} />
        {link.invoice ? (
          <Link to="/finance/invoices/$invoiceId" params={{ invoiceId: link.invoice.id }} className="text-sm font-medium text-slate-900 hover:underline">
            {link.invoice.number} · {link.invoice.title}
          </Link>
        ) : (
          <span className="text-sm font-medium text-slate-900">{link.remoteLabel ?? link.entityType}</span>
        )}
        {link.remoteUrl && <a href={link.remoteUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-700 hover:underline">Open in {provider} ↗</a>}
        <span className="ml-auto text-[11px] text-muted-foreground">{c ? `detected ${fmtWhen(c.detectedAt)}` : link.syncedAt ? `last synced ${fmtWhen(link.syncedAt)}` : ""}</span>
      </div>
      {link.error && <p className="mt-1.5 text-xs text-red-700">{link.error}</p>}
      {c && (
        <>
          <p className="mt-1.5 text-xs text-slate-600">{c.reason}</p>
          <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded border border-border bg-[#fbfbfa] p-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Ours</p>
              <p className="text-slate-800">{String(c.ours.number ?? "")} · total {money(c.ours.total)} · paid {money(c.ours.amountPaid)} · {String(c.ours.status ?? "")}</p>
              <p className="text-muted-foreground">changed {fmtWhen((c.ours.updatedAt as string) ?? null)}</p>
            </div>
            <div className="rounded border border-border bg-[#fbfbfa] p-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">In {provider}</p>
              <p className="text-slate-800">{String(c.theirs.number ?? "")} · total {money(c.theirs.total)} · paid {money(c.theirs.amountPaid)} · {String(c.theirs.status ?? "")}</p>
              <p className="text-muted-foreground">changed {fmtWhen((c.theirs.updatedAt as string) ?? null)}</p>
            </div>
          </div>
        </>
      )}
      <div className="mt-2.5 flex flex-wrap gap-2 text-xs">
        {link.entityType === "invoice" && link.status !== "error" ? (
          <>
            <button type="button" disabled={busy} onClick={() => onResolve("ours")} className="rounded-md bg-indigo-600 px-2.5 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Keep ours — overwrite {provider}</button>
            <button type="button" disabled={busy} onClick={() => onResolve("theirs")} className="rounded-md border border-border bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-muted disabled:opacity-50">Keep {provider}&apos;s — leave it</button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => onResolve("retry")} className="rounded-md border border-border bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-muted disabled:opacity-50">
            {link.entityType === "payment" ? "Done — I fixed it in the ledger" : "Clear and retry on next sync"}
          </button>
        )}
      </div>
    </li>
  );
}

function ProviderPicker({ data, onPick, onStart, onDisconnect, busy }: { data: AccountingOverview; onPick: (p: AccountingProviderKey | null) => void; onStart: (p: "quickbooks" | "xero") => void; onDisconnect: (p: "quickbooks" | "xero") => void; busy: boolean }) {
  const current = data.settings.provider;
  const row = (key: "quickbooks" | "xero"): IntegrationStatus | undefined => data.providers.find((p) => p.provider === key);
  const options: { key: AccountingProviderKey; blurb: string; conn?: IntegrationStatus }[] = [
    { key: "quickbooks", blurb: "Invoices → Invoice, payments → Payment, clients → Customer. One service item carries the lines.", conn: row("quickbooks") },
    { key: "xero", blurb: "Invoices → ACCREC invoice, payments → Payment on your bank account, clients → Contact.", conn: row("xero") },
    { key: "demo", blurb: "A stand-in ledger inside this app for trying the whole flow — including conflicts — without credentials." },
  ];
  return (
    <section className="rounded-lg border border-border bg-white p-4" data-testid="provider-picker">
      <h2 className="text-sm font-semibold text-slate-900">Where the books live</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">One-way: issued invoices and recorded payments are pushed. Edits made in the ledger are never pulled back — they are flagged.</p>
      <ul className="mt-3 space-y-2">
        {options.map((o) => {
          const connected = o.key === "demo" || o.conn?.status === "connected";
          const active = current === o.key;
          return (
            <li key={o.key} className={cn("rounded-md border p-3", active ? "border-indigo-300 bg-indigo-50/40" : "border-border")} data-testid={`provider-${o.key}`}>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  <input type="radio" name="provider" checked={active} disabled={!connected || busy} onChange={() => onPick(o.key)} />
                  {LABEL[o.key]}
                </label>
                {o.conn && (
                  <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", o.conn.status === "connected" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : o.conn.status === "disconnected" ? "border-slate-200 bg-slate-100 text-slate-600" : "border-red-200 bg-red-50 text-red-700")}>
                    {o.conn.status === "connected" ? `Connected${o.conn.accountName ? ` · ${o.conn.accountName}` : ""}` : o.conn.status === "disconnected" ? "Not connected" : o.conn.status.replace("_", " ")}
                  </span>
                )}
                <span className="ml-auto flex gap-2 text-xs">
                  {o.conn && o.conn.status === "disconnected" && (
                    <button type="button" disabled={!o.conn.configured || busy} onClick={() => onStart(o.key as "quickbooks" | "xero")} className="rounded-md bg-indigo-600 px-2.5 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-50" title={o.conn.configured ? undefined : `Add ${o.conn.requiredEnv.join(" and ")} to the API .env first`}>
                      Connect
                    </button>
                  )}
                  {o.conn && o.conn.status !== "disconnected" && (
                    <button type="button" disabled={busy} onClick={() => onDisconnect(o.key as "quickbooks" | "xero")} className="rounded-md border border-border px-2.5 py-1 text-slate-600 hover:bg-muted">Disconnect</button>
                  )}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{o.blurb}</p>
              {o.conn && !o.conn.configured && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Needs <code className="rounded bg-slate-100 px-1">{o.conn.requiredEnv[0]}</code> and <code className="rounded bg-slate-100 px-1">{o.conn.requiredEnv[1]}</code> in the API .env (see .env.example).
                </p>
              )}
              {o.conn?.lastError && <p className="mt-1 text-[11px] text-red-700">{o.conn.lastError}</p>}
            </li>
          );
        })}
      </ul>
      {current && (
        <button type="button" disabled={busy} onClick={() => onPick(null)} className="mt-3 text-xs text-muted-foreground hover:text-red-700">Turn sync off</button>
      )}
    </section>
  );
}

function Options({ settings, onSave, busy }: { settings: AccountingSettings; onSave: (patch: Partial<AccountingSettings>) => void; busy: boolean }) {
  const [form, setForm] = useState(settings);
  useEffect(() => setForm(settings), [settings]);
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  return (
    <section className="rounded-lg border border-border bg-white p-4" data-testid="accounting-options">
      <h2 className="text-sm font-semibold text-slate-900">Options</h2>
      <div className="mt-3 space-y-2 text-sm">
        <label className="flex items-center gap-2 text-slate-800">
          <input type="checkbox" checked={form.autoSync} onChange={(e) => setForm({ ...form, autoSync: e.target.checked })} />
          Sync automatically every hour
        </label>
        <label className="flex items-center gap-2 text-slate-800">
          <input type="checkbox" checked={form.syncPayments} onChange={(e) => setForm({ ...form, syncPayments: e.target.checked })} />
          Push recorded payments too
        </label>
      </div>
      {form.provider === "xero" && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <label className="block">
            <span className="text-muted-foreground">Sales account code</span>
            <input value={form.xeroSalesAccountCode} onChange={(e) => setForm({ ...form, xeroSalesAccountCode: e.target.value })} className={input} />
          </label>
          <label className="block">
            <span className="text-muted-foreground">Bank account code (payments)</span>
            <input value={form.xeroPaymentAccountCode} onChange={(e) => setForm({ ...form, xeroPaymentAccountCode: e.target.value })} className={input} />
          </label>
        </div>
      )}
      {form.provider === "quickbooks" && (
        <label className="mt-3 block text-xs">
          <span className="text-muted-foreground">Service item for invoice lines</span>
          <input value={form.quickbooksItemName} onChange={(e) => setForm({ ...form, quickbooksItemName: e.target.value })} className={input} />
        </label>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Drafts stay here. Invoices sync once sent; voiding syncs as a void. Payments are append-only in the ledger — removing one here flags it for a manual fix over there.
      </p>
      {dirty && (
        <button type="button" disabled={busy} onClick={() => onSave(form)} className="mt-3 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save options</button>
      )}
    </section>
  );
}

/** Demo only: the fake books, with a button that plays the bookkeeper editing a record. */
function DemoLedger({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["accounting-demo"], queryFn: api.getAccountingDemo });
  const edit = useMutation({
    mutationFn: (remoteId: string) => api.editAccountingDemo(remoteId, { total: Math.round(Math.random() * 900 + 100), number: "EDITED-IN-LEDGER" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["accounting-demo"] });
      onChanged();
    },
  });
  return (
    <section className="rounded-lg border border-dashed border-border bg-white" data-testid="demo-ledger">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-900">Demo ledger</h2>
        <span className="text-xs text-muted-foreground">what the fake books contain · &quot;Edit over there&quot; then Sync now to see it flagged</span>
      </div>
      {data.length ? (
        <ul className="divide-y divide-border text-xs">
          {data.map((r) => (
            <li key={r.remoteId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <span className="w-16 capitalize text-muted-foreground">{r.kind}</span>
              <span className="font-mono text-slate-700">{r.remoteId}</span>
              <span className="text-slate-800">{String(r.data.number ?? r.data.name ?? "")}{typeof r.data.total === "number" ? ` · total ${fmtMoney(r.data.total)}` : typeof r.data.amount === "number" ? ` · ${fmtMoney(r.data.amount)}` : ""}{r.data.void ? " · void" : ""}</span>
              <span className="ml-auto text-muted-foreground">v{r.version} · {fmtShortDate(r.updatedAt)}</span>
              {r.kind === "invoice" && (
                <button type="button" disabled={edit.isPending} onClick={() => edit.mutate(r.remoteId)} className="rounded border border-border px-2 py-0.5 text-slate-700 hover:bg-muted">Edit over there</button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">Empty — run a sync.</p>
      )}
    </section>
  );
}
