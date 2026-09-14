import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PortalAccess, type PortalEvent } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Rows 120 + 122: invite a client to the portal (emailed link tied to this
 * project, with an expiry and one-click revoke) and see what they did there.
 */
const STATUS: Record<PortalAccess["status"], string> = { active: "bg-green-50 text-green-700", expired: "bg-amber-50 text-amber-800", revoked: "bg-slate-100 text-slate-500" };
const KIND: Record<string, string> = { opened: "opened the portal", viewed_doc: "viewed", approved: "approved", changes_requested: "requested changes on" };

export function ClientAccessCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const { data: access = [] } = useQuery({ queryKey: ["portal-access", projectId], queryFn: () => api.getPortalAccess(projectId) });
  const { data: events = [] } = useQuery({ queryKey: ["portal-engagement", projectId], queryFn: () => api.getPortalEngagement(projectId), refetchInterval: 60_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["portal-access", projectId] });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => api.createPortalAccess({ email: email.trim(), name: name.trim() || null, projectIds: [projectId], expiresAt: expires ? `${expires}T23:59:59.000Z` : null }),
    onSuccess: () => { setEmail(""); setName(""); setExpires(""); setError(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });
  const resend = useMutation({ mutationFn: (id: string) => api.resendPortalAccess(id), onSuccess: refresh, onError: (e: Error) => setError(e.message) });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokePortalAccess(id), onSuccess: refresh, onError: (e: Error) => setError(e.message) });
  const copy = async (a: PortalAccess) => { try { await navigator.clipboard.writeText(a.link); setCopied(a.id); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ } };
  const field = "rounded-md border border-border bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400";

  return (
    <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2" data-testid="client-access">
      <div className="rounded-lg border border-border bg-white">
        <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Client access</h2>
        <div className="p-4">
          <p className="text-xs text-muted-foreground">Each guest gets an emailed link to this project's portal - read-only, only what is marked client-visible. Links can expire and can be revoked with one click.</p>
          <ul className="mt-3 divide-y divide-border">
            {access.length === 0 && <li className="py-2 text-sm text-muted-foreground">No client links yet.</li>}
            {access.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-slate-800">{a.name ? `${a.name} · ` : ""}{a.email}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {a.expiresAt ? `until ${new Date(a.expiresAt).toLocaleDateString()}` : "no expiry"}
                    {a.lastOpenedAt ? ` · last opened ${new Date(a.lastOpenedAt).toLocaleString()}` : " · never opened"}
                    {a.lastSentAt ? ` · sent ${new Date(a.lastSentAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", STATUS[a.status])}>{a.status}</span>
                {canManage && a.status === "active" && (
                  <>
                    <button type="button" onClick={() => copy(a)} className="text-xs text-indigo-700 hover:underline">{copied === a.id ? "Copied" : "Copy link"}</button>
                    <button type="button" onClick={() => resend.mutate(a.id)} className="text-xs text-slate-600 hover:underline">Resend</button>
                    <button type="button" onClick={() => revoke.mutate(a.id)} className="text-xs text-red-600 hover:underline">Revoke</button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <form onSubmit={(e) => { e.preventDefault(); if (email.trim()) invite.mutate(); }} className="mt-3 flex flex-wrap items-center gap-2" data-testid="client-invite-form">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@company.com" className={`${field} w-48`} required />
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={`${field} w-32`} />
              <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className={field} title="Expiry (optional)" aria-label="Expiry date" />
              <button type="submit" disabled={!email.trim() || invite.isPending} className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Invite</button>
            </form>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-white">
        <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Client engagement</h2>
        <div className="p-4">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No portal activity yet.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="client-engagement">
              {events.slice(0, 30).map((e: PortalEvent) => (
                <li key={e.id} className="flex items-start gap-2 text-sm">
                  <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", e.kind === "approved" ? "bg-green-500" : e.kind === "changes_requested" ? "bg-amber-500" : e.kind === "viewed_doc" ? "bg-indigo-400" : "bg-slate-300")} />
                  <p className="min-w-0 flex-1 text-slate-700">
                    <span className="font-medium text-slate-800">{e.who}</span> {KIND[e.kind] ?? e.kind.replace(/_/g, " ")}{e.label && e.kind !== "opened" ? <> <span className="font-medium">{e.label}</span></> : null}
                    {e.note ? <span className="text-muted-foreground"> · “{e.note}”</span> : null}
                    <span className="ml-1.5 text-xs text-muted-foreground" title={new Date(e.createdAt).toLocaleString()}>{new Date(e.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
