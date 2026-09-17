import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type IntegrationProvider, type IntegrationStatus, type ServiceHealth } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Row 112: connect Google Drive / Dropbox once for the workspace. Files stay
 * where they are - the app only ever stores links (row 124). Row 116 adds the
 * health view (status, last check, retry) on the same cards.
 */
const STATUS: Record<IntegrationStatus["status"], { label: string; cls: string }> = {
  connected: { label: "Connected", cls: "bg-green-50 text-green-700 border-green-200" },
  needs_reconnect: { label: "Needs reconnect", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  failing: { label: "Failing", cls: "bg-red-50 text-red-700 border-red-200" },
  disconnected: { label: "Not connected", cls: "bg-slate-100 text-slate-600 border-slate-200" },
};
const ICON: Partial<Record<IntegrationProvider, string>> = { google_drive: "🟢", dropbox: "🔷" };

const SERVICE_STATUS: Record<ServiceHealth["status"], { label: string; cls: string }> = {
  connected: STATUS.connected,
  failing: STATUS.failing,
  not_set_up: { label: "Not set up", cls: "bg-slate-100 text-slate-600 border-slate-200" },
};

/** Row 116: the non-OAuth services (email, calendar, e-sign) with status, last check and retry. */
function ServiceHealthList({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["integration-health"], queryFn: api.getIntegrationHealth, refetchInterval: 5 * 60_000 });
  const checkEmail = useMutation({ mutationFn: () => api.checkEmailService(), onSuccess: (h) => qc.setQueryData(["integration-health"], h) });
  if (!data) return null;
  return (
    <section className="mt-6" data-testid="service-health">
      <h2 className="text-sm font-semibold text-slate-800">Integration health</h2>
      <p className="text-xs text-muted-foreground">Connected accounts are re-checked every hour; admins get an inbox alert when one breaks. Everything else the app relies on is listed here too.</p>
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-white">
        {data.services.map((s) => {
          const st = SERVICE_STATUS[s.status];
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">{s.label}</p>
                <p className="text-xs text-muted-foreground">{s.detail}{s.lastCheckedAt ? ` · ${new Date(s.lastCheckedAt).toLocaleString()}` : ""}</p>
                {s.lastError && <p className="text-xs text-red-600">{s.lastError}</p>}
              </div>
              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
              {canEdit && s.canCheck && s.id === "email" && (
                <button type="button" disabled={checkEmail.isPending} onClick={() => checkEmail.mutate()} className="rounded-md border border-border bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50">
                  {checkEmail.isPending ? "Checking…" : s.status === "failing" ? "Retry" : "Check now"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ConnectionsSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: all = [], isLoading } = useQuery({ queryKey: ["integrations"], queryFn: api.getIntegrations });
  // Row 131: QuickBooks / Xero are connected from Finance › Accounting.
  const rows = all.filter((r) => r.kind !== "accounting");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) setNotice({ kind: "ok", text: `${q.get("connected") === "dropbox" ? "Dropbox" : "Google Drive"} connected.` });
    if (q.get("error")) setNotice({ kind: "error", text: q.get("error")! });
    if (q.get("connected") || q.get("error")) window.history.replaceState({}, "", window.location.pathname);
  }, []);
  const set = (next: IntegrationStatus[]) => qc.setQueryData(["integrations"], next);
  const start = useMutation({
    mutationFn: (p: IntegrationProvider) => api.startIntegration(p),
    onSuccess: ({ url }) => { window.location.href = url; },
    onError: (e: Error) => setNotice({ kind: "error", text: e.message }),
  });
  const check = useMutation({ mutationFn: (p: IntegrationProvider) => api.checkIntegration(p), onSuccess: set, onError: (e: Error) => setNotice({ kind: "error", text: e.message }) });
  const disconnect = useMutation({ mutationFn: (p: IntegrationProvider) => api.disconnectIntegration(p), onSuccess: set, onError: (e: Error) => setNotice({ kind: "error", text: e.message }) });

  return (
    <div className="max-w-2xl" data-testid="connections">
      <h1 className="text-lg font-semibold text-slate-900">Connections & integration health</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect a cloud drive once for the whole workspace. Members then link existing files to projects, tasks and docs. Files are linked, never copied - one source of truth.
      </p>
      {notice && (
        <p className={cn("mt-3 rounded-md border px-3 py-2 text-sm", notice.kind === "ok" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-700")}>
          {notice.text}
        </p>
      )}
      {isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((r) => {
            const st = STATUS[r.status];
            return (
              <li key={r.provider} className="rounded-lg border border-border bg-white p-4" data-testid={`integration-${r.provider}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xl">{ICON[r.provider]}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800">{r.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.status !== "disconnected" && r.accountEmail ? (
                        <>
                          {r.accountName ? `${r.accountName} · ` : ""}{r.accountEmail}
                          {r.connectedBy ? ` · connected by ${r.connectedBy.name}` : ""}
                          {r.connectedAt ? ` on ${new Date(r.connectedAt).toLocaleDateString()}` : ""}
                        </>
                      ) : r.configured ? (
                        "Not connected yet."
                      ) : (
                        <>Needs setup: add <code className="rounded bg-slate-100 px-1">{r.requiredEnv[0]}</code> and <code className="rounded bg-slate-100 px-1">{r.requiredEnv[1]}</code> to the API .env (see .env.example).</>
                      )}
                    </p>
                  </div>
                  <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
                </div>
                {r.lastError && <p className="mt-2 text-xs text-red-600">Last error: {r.lastError}</p>}
                {canEdit && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    {r.status === "disconnected" ? (
                      <button type="button" disabled={!r.configured || start.isPending} onClick={() => start.mutate(r.provider)} className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700 disabled:opacity-50" title={r.configured ? undefined : "Add the API credentials first"}>
                        Connect {r.label}
                      </button>
                    ) : (
                      <>
                        <button type="button" disabled={check.isPending} onClick={() => check.mutate(r.provider)} className="rounded-md border border-border bg-white px-3 py-1.5 font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50">
                          {check.isPending ? "Checking…" : r.status === "connected" ? "Check now" : "Retry"}
                        </button>
                        {r.status !== "connected" && (
                          <button type="button" disabled={start.isPending} onClick={() => start.mutate(r.provider)} className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Reconnect</button>
                        )}
                        <button type="button" disabled={disconnect.isPending} onClick={() => disconnect.mutate(r.provider)} className="ml-auto text-slate-500 hover:text-red-600">Disconnect</button>
                      </>
                    )}
                    {r.lastCheckedAt && <span className="text-muted-foreground">Last checked {new Date(r.lastCheckedAt).toLocaleString()}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ServiceHealthList canEdit={canEdit} />
    </div>
  );
}
