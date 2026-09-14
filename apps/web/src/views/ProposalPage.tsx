import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Proposal, type ProposalRecipient, type ProposalSection } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { NotFound } from "../components/NotFound.js";
import { ProposalSectionsEditor, ProposalSectionsView } from "../components/ProposalSections.js";
import { PROPOSAL_STATUS } from "./ProposalsPage.js";
import { cn } from "../lib/utils.js";

/** The client-facing link for a recipient token (row 58). */
export function proposalLink(token: string) {
  const base = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}`;
  return `${base}/p/${token}`;
}

/**
 * Rows 56-59: edit the working copy, send it (freezing a version + PDF), and
 * watch each recipient's link go sent → viewed → accepted/declined.
 */
export function ProposalPage() {
  const { proposalId } = useParams({ from: "/crm/proposals/$proposalId" });
  const qc = useQueryClient();
  const { data: p, isError } = useQuery({ queryKey: ["proposal", proposalId], queryFn: () => api.getProposal(proposalId) });
  const [sections, setSections] = useState<ProposalSection[] | null>(null);
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (p && sections === null) setSections(p.sections);
  }, [p, sections]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["proposal", proposalId] });
    qc.invalidateQueries({ queryKey: ["proposals"] });
  };
  const save = useMutation({ mutationFn: (body: Parameters<typeof api.updateProposal>[1]) => api.updateProposal(proposalId, body), onSuccess: refresh });
  const dirty = Boolean(p && sections && JSON.stringify(sections) !== JSON.stringify(p.sections));

  if (isError) return <NotFound what="proposal" />;
  if (!p || !sections) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  const locked = p.status === "accepted";
  const field = "rounded-md border border-border bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500";

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/crm/proposals" className="text-sm text-muted-foreground hover:text-slate-700">Proposals</Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-xs font-medium text-indigo-600">{p.number}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", PROPOSAL_STATUS[p.status].cls)}>{PROPOSAL_STATUS[p.status].label}</span>
        {p.currentVersion > 0 && <span className="text-xs text-muted-foreground">v{p.currentVersion}</span>}
        <div className="ml-auto flex items-center gap-2">
          {dirty && !locked && (
            <button type="button" onClick={() => save.mutate({ sections })} disabled={save.isPending} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-muted disabled:opacity-50">
              {save.isPending ? "Saving…" : "Save sections"}
            </button>
          )}
          <button type="button" onClick={() => setPreview((v) => !v)} className={cn("rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted", preview ? "bg-indigo-50 text-indigo-700" : "text-slate-700")}>
            {preview ? "Edit" : "Preview"}
          </button>
          {!locked && (
            <button type="button" onClick={() => setSending(true)} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
              {p.currentVersion ? `Send v${p.currentVersion + 1}` : "Send"}
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
          <input
            defaultValue={p.title}
            disabled={locked}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== p.title && save.mutate({ title: e.target.value.trim() })}
            className="mb-1 w-full bg-transparent text-2xl font-semibold text-slate-900 outline-none disabled:opacity-80"
          />
          <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {p.company && (
              <Link to="/crm/companies/$companyId" params={{ companyId: p.company.id }} className="hover:text-indigo-700">
                🏢 {p.company.name}
              </Link>
            )}
            {p.contact && <span>👤 {p.contact.name}</span>}
            {p.deal && <span>💼 {p.deal.title}</span>}
            {p.createdBy && <span>by {p.createdBy.name}</span>}
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 rounded-lg border border-border bg-[#fbfbfa] p-3 text-sm md:grid-cols-4">
            <label className="text-xs text-muted-foreground">
              Total
              <input type="number" min={0} step="0.01" defaultValue={p.total} disabled={locked} onBlur={(e) => Number(e.target.value) !== p.total && save.mutate({ total: Number(e.target.value) || 0 })} className={`${field} mt-0.5 w-full`} />
            </label>
            <label className="text-xs text-muted-foreground">
              Currency
              <input defaultValue={p.currency} maxLength={3} disabled={locked} onBlur={(e) => e.target.value.trim().length === 3 && e.target.value.trim().toUpperCase() !== p.currency && save.mutate({ currency: e.target.value.trim().toUpperCase() })} className={`${field} mt-0.5 w-full uppercase`} />
            </label>
            <label className="text-xs text-muted-foreground">
              Valid until
              <input type="date" defaultValue={p.validUntil?.slice(0, 10) ?? ""} disabled={locked} onBlur={(e) => (e.target.value || null) !== (p.validUntil?.slice(0, 10) ?? null) && save.mutate({ validUntil: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : null })} className={`${field} mt-0.5 w-full`} />
            </label>
            <div className="text-xs text-muted-foreground">
              Sent versions
              <p className="mt-1 text-sm font-medium text-slate-800">{p.currentVersion || "none yet"}</p>
            </div>
          </div>

          {locked && (
            <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Accepted on {fmtShortDate(p.acceptedAt!)} — the content is frozen. Start a new proposal for changes.
            </p>
          )}
          {preview || locked ? <ProposalSectionsView sections={locked ? p.sections : sections} /> : <ProposalSectionsEditor sections={sections} onChange={setSections} />}
        </div>

        <aside className="w-96 shrink-0 overflow-y-auto border-l border-border bg-[#fbfbfa] px-4 py-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Versions & recipients</h2>
          {p.versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not sent yet. Sending freezes a numbered version with a PDF and gives each contact their own link.</p>
          ) : (
            <ul className="space-y-3">
              {p.versions.map((v) => (
                <li key={v.id} className={cn("rounded-lg border bg-white p-3", v.version === p.currentVersion ? "border-indigo-200" : "border-border")}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">v{v.version}</span>
                    {v.version === p.currentVersion && <span className="rounded bg-indigo-50 px-1.5 text-[10px] font-medium text-indigo-700">current</span>}
                    <span className="text-[11px] text-muted-foreground">
                      {fmtShortDate(v.sentAt)}
                      {v.sentBy ? ` · ${v.sentBy.name}` : ""}
                    </span>
                    {v.pdfUrl && (
                      <a href={v.pdfUrl} target="_blank" rel="noreferrer" className="ml-auto text-[11px] font-medium text-indigo-600 hover:underline">
                        PDF ↗
                      </a>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {v.title} · {fmtMoney(v.total, v.currency)}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {v.recipients.map((rc) => (
                      <RecipientRow key={rc.id} rc={rc} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {sending && <SendDialog proposal={p} onClose={() => setSending(false)} onSent={refresh} pendingSections={dirty ? sections : null} />}
    </div>
  );
}

function RecipientRow({ rc }: { rc: ProposalRecipient }) {
  const [copied, setCopied] = useState(false);
  const link = proposalLink(rc.token);
  const state = rc.acceptedAt ? "accepted" : rc.declinedAt ? "declined" : rc.viewedAt ? "viewed" : "sent";
  const tone = { sent: "text-slate-500", viewed: "text-indigo-700", accepted: "text-emerald-700", declined: "text-red-700" }[state];
  return (
    <li className="rounded-md border border-border px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-slate-800">{rc.name}</span>
        {rc.email && <span className="truncate text-muted-foreground">{rc.email}</span>}
        <span className={cn("ml-auto font-medium capitalize", tone)}>{state}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
        <span>sent {fmtShortDate(rc.sentAt)}</span>
        {rc.viewedAt && <span>viewed {fmtShortDate(rc.viewedAt)} ({rc.viewCount}×)</span>}
        {rc.acceptedAt && <span className="text-emerald-700">signed by {rc.signerName} {fmtShortDate(rc.acceptedAt)}</span>}
        {rc.declinedAt && <span className="text-red-700">declined {fmtShortDate(rc.declinedAt)}{rc.declineReason ? `: ${rc.declineReason}` : ""}</span>}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <input readOnly value={link} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded border border-border bg-[#fbfbfa] px-1.5 py-0.5 text-[10px] text-slate-600" />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded border border-border px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-muted"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <a href={link} target="_blank" rel="noreferrer" className="rounded border border-border px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-muted">
          Open
        </a>
      </div>
    </li>
  );
}

/** Row 58: pick who gets a link. Unsaved section edits are saved first so the version matches the editor. */
function SendDialog({ proposal, pendingSections, onClose, onSent }: { proposal: Proposal; pendingSections: ProposalSection[] | null; onClose: () => void; onSent: () => void }) {
  const { data: contacts = [] } = useQuery({
    queryKey: ["contacts", "company", proposal.companyId ?? ""],
    queryFn: () => api.getContacts(proposal.companyId ? { companyId: proposal.companyId } : {}),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set(proposal.contactId ? [proposal.contactId] : []));
  const [adhocName, setAdhocName] = useState("");
  const [adhocEmail, setAdhocEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: async () => {
      if (pendingSections) await api.updateProposal(proposal.id, { sections: pendingSections });
      const recipients: { contactId?: string; name?: string; email?: string }[] = [...picked].map((contactId) => ({ contactId }));
      if (adhocName.trim()) recipients.push({ name: adhocName.trim(), email: adhocEmail.trim() || undefined });
      return api.sendProposal(proposal.id, recipients);
    },
    onSuccess: () => {
      onSent();
      onClose();
    },
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  const count = picked.size + (adhocName.trim() ? 1 : 0);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Send v{proposal.currentVersion + 1}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          This freezes the current content as version {proposal.currentVersion + 1} with a PDF. Each person below gets their own link, so you can see who viewed and who signed.
        </p>
        <div className="mt-4 max-h-56 overflow-y-auto rounded-md border border-border">
          {contacts.length ? (
            contacts.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-muted">
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setPicked(next);
                  }}
                  className="accent-indigo-600"
                />
                <span className="font-medium text-slate-800">{c.fullName}</span>
                <span className="truncate text-xs text-muted-foreground">{c.email ?? c.title ?? ""}</span>
                {c.isPrimary && <span className="ml-auto rounded bg-indigo-50 px-1.5 text-[10px] text-indigo-700">Primary</span>}
              </label>
            ))
          ) : (
            <p className="px-3 py-3 text-xs text-muted-foreground">No contacts on this client yet — add one below or in Contacts.</p>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <input value={adhocName} onChange={(e) => setAdhocName(e.target.value)} placeholder="Or a name…" className="rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-indigo-500" />
          <input value={adhocEmail} onChange={(e) => setAdhocEmail(e.target.value)} placeholder="…and email (optional)" className="rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-indigo-500" />
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">No email is sent automatically yet — copy each link from the Versions panel and send it your usual way.</p>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => send.mutate()} disabled={!count || send.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {send.isPending ? "Sending…" : `Send to ${count || "…"}`}
          </button>
        </div>
      </div>
    </>
  );
}
