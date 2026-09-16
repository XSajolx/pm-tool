import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { ProposalSectionsView } from "../components/ProposalSections.js";
import { SignaturePad, type SignatureValue } from "../components/SignaturePad.js";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

/**
 * Row 158: what the client opens from their link — the frozen contract text,
 * who has signed, and a signature box (type or draw). No login.
 */
export function PublicContractPage() {
  const { token } = useParams({ from: "/c/$token" });
  const qc = useQueryClient();
  const { data, isError, isLoading } = useQuery({ queryKey: ["public-contract", token], queryFn: () => api.getPublicContract(token), retry: false });
  const [sig, setSig] = useState<SignatureValue>({ signatureType: "typed", name: "", title: "", image: null });
  const [agreed, setAgreed] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = (next: unknown) => {
    qc.setQueryData(["public-contract", token], next);
    setError(null);
  };
  const sign = useMutation({ mutationFn: () => api.signPublicContract(token, { signatureType: sig.signatureType, name: sig.name, title: sig.title, image: sig.image, agreed }), onSuccess: done, onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")) });
  const decline = useMutation({ mutationFn: () => api.declinePublicContract(token, reason), onSuccess: (d) => { done(d); setDeclining(false); }, onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")) });

  if (isLoading) return <Shell><p className="text-sm text-slate-500">Loading…</p></Shell>;
  if (isError || !data)
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-slate-900">This link isn't valid</h1>
        <p className="mt-1 text-sm text-slate-600">It may have been withdrawn or replaced. Ask the sender for a fresh link.</p>
      </Shell>
    );
  const { contract: c, signer, from } = data;
  const signed = Boolean(signer.signedAt);
  const canAct = !signed && !signer.declinedAt && !c.expired && c.status !== "declined" && c.status !== "expired";
  const ready = agreed && sig.name.trim().length >= 2 && (sig.signatureType === "typed" || Boolean(sig.image));
  if (!sig.name && signer.name && !signed) setSig((s) => ({ ...s, name: signer.name }));

  return (
    <Shell brand={from}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wide text-slate-500">{c.kindLabel} · {c.number}</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">{c.title}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {c.company ? `Between ${from.name} and ${c.company}` : `From ${from.name}`}
            {c.sentAt ? ` · sent ${new Date(c.sentAt).toLocaleDateString()}` : ""}
            {c.validUntil && !signed ? ` · please sign by ${new Date(c.validUntil).toLocaleDateString()}` : ""}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${c.status === "signed" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : signed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : c.expired || c.status === "declined" ? "border-red-200 bg-red-50 text-red-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>
          {c.status === "signed" ? "Fully executed" : signed ? "You have signed" : c.expired ? "Expired" : c.status === "declined" ? "Declined" : "Awaiting your signature"}
        </span>
      </div>

      {signed && (
        <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          ✅ Signed by <b>{signer.signatureName}</b>{signer.signatureTitle ? `, ${signer.signatureTitle}` : ""} on {when(signer.signedAt)}.
          {c.status !== "signed" && " We'll countersign and send you the executed copy."}
        </div>
      )}
      {signer.declinedAt && !signed && <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">You declined this contract on {new Date(signer.declinedAt).toLocaleDateString()}.</div>}
      {c.expired && !signed && <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">The signing deadline has passed. Ask {from.name} for a fresh contract.</div>}

      <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50/60 p-5">
        <ProposalSectionsView sections={c.sections} />
      </div>

      <div className="mt-6">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Parties</p>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {c.parties.map((p, i) => (
            <li key={i} className={`rounded-lg border px-3 py-2 text-sm ${p.me ? "border-indigo-200 bg-indigo-50/40" : "border-slate-200"}`}>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">{p.role === "company" ? from.name : c.company ?? "Client"}{p.me ? " · you" : ""}</p>
              <p className="font-medium text-slate-900">{p.name}{p.title ? <span className="font-normal text-slate-500">, {p.title}</span> : null}</p>
              {p.signedAt ? (
                <div className="mt-1">
                  {p.signatureType === "drawn" && p.signatureImage ? <img src={p.signatureImage} alt="signature" className="h-10" /> : <p className="font-serif text-lg italic text-slate-800">{p.name}</p>}
                  <p className="text-[11px] text-emerald-700">signed {when(p.signedAt)}</p>
                </div>
              ) : (
                <p className="mt-1 text-[11px] text-slate-400">not yet signed</p>
              )}
            </li>
          ))}
        </ul>
      </div>

      {canAct && (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Sign this agreement</h2>
          <p className="mt-1 text-xs text-slate-500">Type your name or draw your signature. We record the time, your name, IP address and device for the audit trail. Electronic signatures are legally binding.</p>
          <div className="mt-4"><SignaturePad value={sig} onChange={setSig} accent={from.color} /></div>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 accent-indigo-600" />
            I have read this agreement and I agree to be bound by its terms.
          </label>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => sign.mutate()} disabled={!ready || sign.isPending} className="rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: from.color }}>
              {sign.isPending ? "Signing…" : "Sign agreement"}
            </button>
            {!declining ? (
              <button type="button" onClick={() => setDeclining(true)} className="rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">Decline</button>
            ) : (
              <div className="flex flex-1 items-center gap-2">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none" />
                <button type="button" onClick={() => decline.mutate()} disabled={decline.isPending} className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">Confirm decline</button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-5 text-xs text-slate-500">
        <a href={c.pdfUrl} target="_blank" rel="noreferrer" className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">Download PDF</a>
        <span>Viewing as {signer.name}</span>
      </div>
    </Shell>
  );
}

function Shell({ children, brand }: { children: React.ReactNode; brand?: { name: string; color: string; logoUrl: string | null; footer: string | null } }) {
  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 text-slate-800">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {brand && (
          <div className="flex items-center gap-3 px-6 py-3 sm:px-10" style={{ background: brand.color }}>
            {brand.logoUrl ? <img src={brand.logoUrl} alt="" className="h-7 w-auto rounded bg-white/90 p-0.5" /> : <span className="flex h-7 w-7 items-center justify-center rounded bg-white/20 text-xs font-bold text-white">{brand.name.slice(0, 1)}</span>}
            <span className="text-sm font-semibold text-white">{brand.name}</span>
          </div>
        )}
        <div className="px-6 py-8 sm:px-10">{children}</div>
      </div>
      <p className="mx-auto mt-4 max-w-3xl text-center text-[11px] text-slate-400">{brand?.footer || "Sent with 4S PM Tool"}</p>
    </div>
  );
}
