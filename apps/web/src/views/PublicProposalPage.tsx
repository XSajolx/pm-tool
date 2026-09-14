import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { ProposalSectionsView } from "../components/ProposalSections.js";

function money(n: number, c: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);
  } catch {
    return `${c} ${n.toFixed(2)}`;
  }
}

/**
 * Rows 58-59: what the client sees from their link — the frozen version, a
 * PDF, and Accept & sign (typed signature) or Decline. No login.
 */
export function PublicProposalPage() {
  const { token } = useParams({ from: "/p/$token" });
  const qc = useQueryClient();
  const { data, isError, isLoading } = useQuery({ queryKey: ["public-proposal", token], queryFn: () => api.getPublicProposal(token), retry: false });
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = (next: unknown) => {
    qc.setQueryData(["public-proposal", token], next);
    setError(null);
  };
  const accept = useMutation({ mutationFn: () => api.acceptPublicProposal(token, { signerName: name, signerTitle: title, agreed }), onSuccess: done, onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")) });
  const decline = useMutation({ mutationFn: () => api.declinePublicProposal(token, reason), onSuccess: (d) => { done(d); setDeclining(false); }, onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")) });

  if (isLoading) return <Shell><p className="text-sm text-slate-500">Loading…</p></Shell>;
  if (isError || !data)
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-slate-900">This link isn't valid</h1>
        <p className="mt-1 text-sm text-slate-600">It may have been replaced by a newer version. Ask the sender for a fresh link.</p>
      </Shell>
    );
  const { proposal: p, recipient } = data;
  const signed = Boolean(recipient.acceptedAt);
  const canAct = !signed && !recipient.declinedAt && p.latest && !p.expired && p.status !== "accepted";

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wide text-slate-500">Proposal {p.number} · version {p.version}</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">{p.title}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {p.company ? `Prepared for ${p.company}` : ""}
            {p.from ? ` by ${p.from}` : ""} · sent {new Date(p.sentAt).toLocaleDateString()}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-right">
          <p className="text-xs text-slate-500">Total</p>
          <p className="text-xl font-semibold text-slate-900">{money(p.total, p.currency)}</p>
          {p.validUntil && <p className="text-[11px] text-slate-500">valid until {new Date(p.validUntil).toLocaleDateString()}</p>}
        </div>
      </div>

      {signed && (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          ✅ Accepted and signed by <b>{recipient.signerName}</b>
          {recipient.signerTitle ? `, ${recipient.signerTitle}` : ""} on {new Date(recipient.acceptedAt!).toLocaleString()}.
        </div>
      )}
      {recipient.declinedAt && !signed && <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">You declined this proposal on {new Date(recipient.declinedAt).toLocaleDateString()}.</div>}
      {!p.latest && <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">A newer version of this proposal has been sent. This one is kept for reference.</div>}
      {p.expired && !signed && <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">This proposal has expired. Ask {p.from ?? "the sender"} for a refreshed version.</div>}
      {p.status === "accepted" && !signed && <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">This proposal has already been accepted.</div>}

      <ProposalSectionsView sections={p.sections} />

      <div className="mt-8 flex items-center gap-3 text-xs text-slate-500">
        {p.pdfUrl && (
          <a href={p.pdfUrl} target="_blank" rel="noreferrer" className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">
            Download PDF
          </a>
        )}
        <span>Viewing as {recipient.name}</span>
      </div>

      {canAct && (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Accept & sign</h2>
          <p className="mt-1 text-xs text-slate-500">Typing your full name below is your electronic signature. We record the time, your name and your device for the audit trail.</p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title / role (optional)" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
          </div>
          {name.trim() && (
            <p className="mt-3 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 font-serif text-xl italic text-slate-800">{name.trim()}</p>
          )}
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 accent-indigo-600" />
            I have read this proposal and agree to its scope, timeline and terms.
          </label>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => accept.mutate()} disabled={!agreed || name.trim().length < 2 || accept.isPending} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {accept.isPending ? "Signing…" : "Accept & sign"}
            </button>
            {!declining ? (
              <button type="button" onClick={() => setDeclining(true)} className="rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">
                Decline
              </button>
            ) : (
              <div className="flex flex-1 items-center gap-2">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none" />
                <button type="button" onClick={() => decline.mutate()} disabled={decline.isPending} className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  Confirm decline
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 text-slate-800">
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-sm sm:px-10">{children}</div>
      <p className="mx-auto mt-4 max-w-3xl text-center text-[11px] text-slate-400">Sent with 4S PM Tool</p>
    </div>
  );
}
