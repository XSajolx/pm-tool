import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Contract, type ContractFields, type ContractKind, type ContractSigner, type ProposalSection } from "../lib/api.js";
import { fmtShortDate } from "../lib/format.js";
import { useAuth } from "../lib/auth.js";
import { useEscape } from "../lib/useEscape.js";
import { NotFound } from "../components/NotFound.js";
import { ProposalSectionsEditor, ProposalSectionsView } from "../components/ProposalSections.js";
import { SignaturePad, type SignatureValue } from "../components/SignaturePad.js";
import { CrmField, input } from "./CompaniesPage.js";
import { CONTRACT_STATUS, KIND_LABEL } from "./ContractsPage.js";
import { cn } from "../lib/utils.js";

/** The client-facing signing link (row 158). */
export function contractLink(token: string) {
  const base = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}`;
  return `${base}/c/${token}`;
}

/**
 * Row 158: draft the text (with merge fields), pick who signs, send links,
 * watch signatures land, countersign, and keep the executed PDF.
 */
export function ContractPage() {
  const { contractId } = useParams({ from: "/crm/contracts/$contractId" });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { role, user } = useAuth();
  const admin = role === "owner" || role === "admin";
  const { data: c, isError } = useQuery({ queryKey: ["contract", contractId], queryFn: () => api.getContract(contractId) });
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ContractKind>("service_agreement");
  const [sections, setSections] = useState<ProposalSection[]>([]);
  const [fields, setFields] = useState<ContractFields>({});
  const [companyId, setCompanyId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [requireCountersign, setRequireCountersign] = useState(true);
  const [signers, setSigners] = useState<{ contactId: string | null; name: string; email: string }[]>([]);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countersigning, setCountersigning] = useState(false);
  const [saveTpl, setSaveTpl] = useState(false);
  const { data: contacts = [] } = useQuery({ queryKey: ["contacts", "company", companyId], queryFn: () => api.getContacts({ companyId }), enabled: Boolean(companyId) });

  useEffect(() => {
    if (!c) return;
    setTitle(c.title);
    setKind(c.kind);
    setSections(c.sections);
    setFields(c.fields);
    setCompanyId(c.company?.id ?? "");
    setProjectId(c.project?.id ?? "");
    setValidUntil(c.validUntil?.slice(0, 10) ?? "");
    setRequireCountersign(c.requireCountersign);
    setSigners(c.signers.filter((s) => s.role === "client").map((s) => ({ contactId: s.contactId, name: s.name, email: s.email ?? "" })));
    setDirty(false);
  }, [c]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["contract", contractId] });
    qc.invalidateQueries({ queryKey: ["contracts"] });
  };
  const fail = (e: unknown) => setError((e as Error).message.replace(/^API \d+: /, ""));
  const ok = () => {
    setError(null);
    refresh();
  };
  const save = useMutation({
    mutationFn: () =>
      api.updateContract(contractId, {
        title: title.trim(),
        kind,
        sections,
        fields,
        companyId: companyId || null,
        projectId: projectId || null,
        validUntil: validUntil ? new Date(validUntil).toISOString() : null,
        requireCountersign,
        signers: signers.filter((s) => s.contactId || s.name.trim()).map((s) => ({ contactId: s.contactId, name: s.name, email: s.email || null })),
      }),
    onSuccess: ok,
    onError: fail,
  });
  const send = useMutation({ mutationFn: () => api.sendContract(contractId), onSuccess: ok, onError: fail });
  const reopen = useMutation({ mutationFn: () => api.reopenContract(contractId), onSuccess: ok, onError: fail });
  const pdf = useMutation({ mutationFn: () => api.openContractPdf(contractId), onError: fail });
  const remove = useMutation({ mutationFn: () => api.archiveContract(contractId), onSuccess: () => { refresh(); navigate({ to: "/crm/contracts" }); }, onError: fail });
  const setCompanySigner = useMutation({ mutationFn: (userId: string) => api.setContractCompanySigner(contractId, userId), onSuccess: ok, onError: fail });

  if (isError) return <NotFound what="contract" />;
  if (!c) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  const editable = c.status === "draft";
  const st = CONTRACT_STATUS[c.status];
  const companySigner = c.signers.find((s) => s.role === "company");
  const clientSigners = c.signers.filter((s) => s.role === "client");
  const canCountersign = admin && ["sent", "viewed", "signed"].includes(c.status) && companySigner && !companySigner.signedAt;
  const nobodySigned = !c.signers.some((s) => s.signedAt);
  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };
  const setField = (patch: Partial<ContractFields>) => {
    setFields((f) => ({ ...f, ...patch }));
    setDirty(true);
  };
  const btn = "rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40";
  const ghost = `${btn} border border-border text-slate-700 hover:bg-muted`;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/crm/contracts" className="text-sm text-muted-foreground hover:text-slate-700">Contracts</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-sm font-semibold text-slate-800">{c.number}</h1>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
        <span className="text-xs text-muted-foreground">{KIND_LABEL[c.kind]}</span>
        {c.sentAt && <span className="text-xs text-muted-foreground">sent {fmtShortDate(c.sentAt)}</span>}
        {c.signedAt && <span className="text-xs text-emerald-700">executed {fmtShortDate(c.signedAt)}</span>}
        {c.declinedAt && <span className="text-xs text-red-700">declined {fmtShortDate(c.declinedAt)}{c.declineReason ? ` · ${c.declineReason}` : ""}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button onClick={() => pdf.mutate()} disabled={pdf.isPending} className={ghost}>PDF</button>
          {admin && <button onClick={() => setSaveTpl(true)} className={ghost} title="Save the current text as a reusable template">Save as template</button>}
          <button onClick={() => setPreview((v) => !v)} className={cn(ghost, preview && "bg-indigo-50 text-indigo-700")}>{preview ? "Edit" : "Preview"}</button>
          {editable && <button onClick={() => save.mutate()} disabled={!dirty || save.isPending} className={ghost}>{save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}</button>}
          {editable && admin && (
            <button onClick={() => send.mutate()} disabled={dirty || send.isPending || !clientSigners.length} title={dirty ? "Save first" : !clientSigners.length ? "Add a client signer" : "Freeze the text and create signing links"} className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}>
              {send.isPending ? "Sending…" : "Send for signature"}
            </button>
          )}
          {canCountersign && <button onClick={() => setCountersigning(true)} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>Countersign</button>}
          {!editable && admin && nobodySigned && <button onClick={() => reopen.mutate()} disabled={reopen.isPending} className="text-sm text-slate-500 hover:text-slate-700">Back to draft</button>}
          {admin && (editable || c.status === "declined" || c.status === "expired") && <button onClick={() => remove.mutate()} disabled={remove.isPending} className="text-sm text-slate-500 hover:text-red-700">Delete</button>}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-700">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[1fr_340px]">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-white p-4 lg:grid-cols-3">
              <div className="lg:col-span-2"><CrmField label="Title"><input value={title} onChange={(e) => touch(setTitle)(e.target.value)} disabled={!editable} className={input} /></CrmField></div>
              <CrmField label="Type">
                <select value={kind} onChange={(e) => touch(setKind)(e.target.value as ContractKind)} disabled={!editable} className={input}>
                  {(Object.keys(KIND_LABEL) as ContractKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
              </CrmField>
              <CrmField label="Client company">
                <select value={companyId} onChange={(e) => touch(setCompanyId)(e.target.value)} disabled={!editable} className={input}>
                  <option value="">—</option>
                  {companies.map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}
                </select>
              </CrmField>
              <CrmField label="Project">
                <select value={projectId} onChange={(e) => touch(setProjectId)(e.target.value)} disabled={!editable} className={input}>
                  <option value="">—</option>
                  {projects.filter((p) => p.kind !== "internal").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </CrmField>
              <CrmField label="Sign by"><input type="date" value={validUntil} onChange={(e) => touch(setValidUntil)(e.target.value)} disabled={!editable} className={input} /></CrmField>
              <CrmField label={`Fee ({{fee}})`}><input type="number" step="0.01" value={fields.fee ?? ""} onChange={(e) => setField({ fee: e.target.value === "" ? null : Number(e.target.value) })} disabled={!editable} className={input} /></CrmField>
              <CrmField label="Currency"><input value={fields.currency ?? "USD"} maxLength={3} onChange={(e) => setField({ currency: e.target.value.toUpperCase() })} disabled={!editable} className={input} /></CrmField>
              <div className="grid grid-cols-2 gap-2">
                <CrmField label="Start ({{start_date}})"><input type="date" value={fields.startDate ?? ""} onChange={(e) => setField({ startDate: e.target.value || null })} disabled={!editable} className={input} /></CrmField>
                <CrmField label="End ({{end_date}})"><input type="date" value={fields.endDate ?? ""} onChange={(e) => setField({ endDate: e.target.value || null })} disabled={!editable} className={input} /></CrmField>
              </div>
            </div>

            {preview || !editable ? (
              <div className="rounded-lg border border-border bg-white p-6">
                {!editable && c.rendered && <p className="mb-4 rounded-md bg-slate-50 px-3 py-2 text-[11px] text-muted-foreground">This is the text the client received — placeholders were filled in when it was sent.</p>}
                {editable && <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">Preview shows the working copy. Placeholders are filled in when you send.</p>}
                <ProposalSectionsView sections={c.rendered ?? sections} />
              </div>
            ) : (
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="mr-1">Merge fields:</span>
                  {c.placeholders.map(([ph, hint]) => (
                    <button key={ph} type="button" title={hint} onClick={() => { void navigator.clipboard?.writeText(ph); }} className="rounded border border-border bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600 hover:bg-muted">{ph}</button>
                  ))}
                  <span className="ml-1">(click to copy)</span>
                </div>
                <ProposalSectionsEditor sections={sections} onChange={(next) => { setSections(next); setDirty(true); }} />
              </div>
            )}
          </div>

          <aside className="space-y-4">
            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Client signers</h2>
              {editable ? (
                <div className="mt-2 space-y-2">
                  {signers.map((s, i) => (
                    <div key={i} className="rounded-md border border-border p-2 text-xs">
                      <select
                        value={s.contactId ?? ""}
                        onChange={(e) => {
                          const ct = contacts.find((x) => x.id === e.target.value);
                          setSigners((l) => l.map((x, j) => (j === i ? { contactId: e.target.value || null, name: ct?.fullName ?? x.name, email: ct?.email ?? x.email } : x)));
                          setDirty(true);
                        }}
                        className={input + " mb-1.5"}
                      >
                        <option value="">Someone not in contacts…</option>
                        {contacts.map((ct) => <option key={ct.id} value={ct.id}>{ct.fullName}</option>)}
                      </select>
                      <div className="grid grid-cols-2 gap-1.5">
                        <input value={s.name} onChange={(e) => { setSigners((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); setDirty(true); }} placeholder="Full name" className={input} />
                        <input value={s.email} onChange={(e) => { setSigners((l) => l.map((x, j) => (j === i ? { ...x, email: e.target.value } : x))); setDirty(true); }} placeholder="Email" className={input} />
                      </div>
                      <button type="button" onClick={() => { setSigners((l) => l.filter((_, j) => j !== i)); setDirty(true); }} className="mt-1 text-[11px] text-slate-500 hover:text-red-700">Remove</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => { setSigners((l) => [...l, { contactId: null, name: "", email: "" }]); setDirty(true); }} className="w-full rounded-md border border-dashed border-border py-1.5 text-xs text-slate-600 hover:bg-muted">+ Add signer</button>
                </div>
              ) : (
                <ul className="mt-2 space-y-2">
                  {clientSigners.map((s) => <SignerRow key={s.id} s={s} />)}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Our signature</h2>
              <label className="mt-2 flex items-start gap-2 text-xs">
                <input type="checkbox" checked={requireCountersign} onChange={(e) => touch(setRequireCountersign)(e.target.checked)} disabled={!editable} className="mt-0.5" />
                <span><span className="font-medium text-slate-800">Countersign required</span><br /><span className="text-muted-foreground">The contract counts as executed only once someone on our side signs too.</span></span>
              </label>
              {companySigner && (
                <div className="mt-3 text-xs">
                  {editable && admin ? (
                    <CrmField label="Signs for us">
                      <select value={companySigner.userId ?? ""} onChange={(e) => setCompanySigner.mutate(e.target.value)} className={input}>
                        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </CrmField>
                  ) : (
                    <p className="text-slate-700">{companySigner.name}</p>
                  )}
                  {companySigner.signedAt ? (
                    <p className="mt-1 text-emerald-700">✓ signed {fmtShortDate(companySigner.signedAt)} by {companySigner.signatureName}</p>
                  ) : c.status !== "draft" ? (
                    <p className="mt-1 text-muted-foreground">Not yet signed{companySigner.userId === user?.id ? " — that's you" : ""}.</p>
                  ) : null}
                  {canCountersign && companySigner.userId === user?.id && <button onClick={() => setCountersigning(true)} className="mt-2 w-full rounded-md bg-emerald-600 py-1.5 text-xs font-medium text-white hover:bg-emerald-700">Sign now</button>}
                </div>
              )}
            </section>

            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Audit trail</h2>
              <ol className="mt-2 space-y-1.5 text-[11px] text-muted-foreground">
                {c.events.map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="w-14 shrink-0 tabular-nums">{fmtShortDate(e.at)}</span>
                    <span className="text-slate-700">{e.detail ?? e.kind}{e.ip ? <span className="text-muted-foreground"> · {e.ip}</span> : null}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="rounded-lg border border-border bg-white p-4 text-xs text-muted-foreground">
              <dl className="space-y-1">
                {c.createdBy && <div className="flex justify-between"><dt>Created by</dt><dd className="text-slate-700">{c.createdBy.name}</dd></div>}
                {c.deal && <div className="flex justify-between"><dt>Deal</dt><dd><Link to="/crm/deals" search={{ deal: c.deal.id }} className="text-indigo-600 hover:underline">{c.deal.title}</Link></dd></div>}
                {c.company && <div className="flex justify-between"><dt>Client</dt><dd><Link to="/crm/companies/$companyId" params={{ companyId: c.company.id }} className="text-indigo-600 hover:underline">{c.company.name}</Link></dd></div>}
                {c.project && <div className="flex justify-between"><dt>Project</dt><dd><Link to="/projects/$projectId" params={{ projectId: c.project.id }} className="text-indigo-600 hover:underline">{c.project.name}</Link></dd></div>}
                {c.pdfKey && <div className="flex justify-between"><dt>Executed PDF</dt><dd><button onClick={() => pdf.mutate()} className="text-indigo-600 hover:underline">open</button></dd></div>}
              </dl>
            </section>
          </aside>
        </div>
      </div>

      {countersigning && <CountersignDialog contract={c} defaultName={user?.name ?? ""} onClose={() => setCountersigning(false)} onDone={() => { setCountersigning(false); ok(); }} />}
      {saveTpl && <SaveTemplateDialog contract={c} onClose={() => setSaveTpl(false)} />}
    </div>
  );
}

function SignerRow({ s }: { s: ContractSigner }) {
  const [copied, setCopied] = useState(false);
  const link = s.token ? contractLink(s.token) : null;
  const state = s.signedAt ? "signed" : s.declinedAt ? "declined" : s.viewedAt ? "viewed" : "sent";
  const tone = { sent: "text-slate-500", viewed: "text-indigo-700", signed: "text-emerald-700", declined: "text-red-700" }[state];
  return (
    <li className="rounded-md border border-border px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-slate-800">{s.name}</span>
        {s.email && <span className="truncate text-muted-foreground">{s.email}</span>}
        <span className={cn("ml-auto font-medium capitalize", tone)}>{state}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
        {s.sentAt && <span>sent {fmtShortDate(s.sentAt)}</span>}
        {s.viewedAt && <span>opened {fmtShortDate(s.viewedAt)} ({s.viewCount}×)</span>}
        {s.signedAt && <span className="text-emerald-700">signed as {s.signatureName} ({s.signatureType}) {fmtShortDate(s.signedAt)}{s.signatureIp ? ` · ${s.signatureIp}` : ""}</span>}
        {s.declinedAt && <span className="text-red-700">declined {fmtShortDate(s.declinedAt)}{s.declineReason ? `: ${s.declineReason}` : ""}</span>}
      </div>
      {s.signatureImage && <img src={s.signatureImage} alt="signature" className="mt-1 h-10 rounded border border-border bg-white" />}
      {link && (
        <div className="mt-1 flex items-center gap-1">
          <input readOnly value={link} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded border border-border bg-[#fbfbfa] px-1.5 py-0.5 text-[10px] text-slate-600" />
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-muted">{copied ? "Copied" : "Copy link"}</button>
          <a href={link} target="_blank" rel="noreferrer" className="rounded border border-border px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-muted">Open</a>
        </div>
      )}
    </li>
  );
}

function CountersignDialog({ contract, defaultName, onClose, onDone }: { contract: Contract; defaultName: string; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [sig, setSig] = useState<SignatureValue>({ signatureType: "typed", name: defaultName, title: "", image: null });
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sign = useMutation({
    mutationFn: () => api.countersignContract(contract.id, { signatureType: sig.signatureType, name: sig.name, title: sig.title, image: sig.image, agreed }),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  const ready = agreed && sig.name.trim().length >= 2 && (sig.signatureType === "typed" || Boolean(sig.image));
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Countersign {contract.number}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Your signature is recorded with the time, your name and IP for the audit trail.</p>
        <div className="mt-4"><SignaturePad value={sig} onChange={setSig} /></div>
        <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 accent-indigo-600" />
          I am authorised to sign this agreement on behalf of the company.
        </label>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => sign.mutate()} disabled={!ready || sign.isPending} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{sign.isPending ? "Signing…" : "Sign"}</button>
        </div>
      </div>
    </>
  );
}

function SaveTemplateDialog({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  useEscape(onClose);
  const qc = useQueryClient();
  const [name, setName] = useState(`${contract.title}`);
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.saveContractAsTemplate(contract.id, { name: name.trim(), kind: contract.kind, isDefault }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["contract-templates"] }); onClose(); },
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Save as template</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">The working text (with its placeholders) becomes a {KIND_LABEL[contract.kind].toLowerCase()} template in Settings.</p>
        <div className="mt-4 space-y-3">
          <CrmField label="Template name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={input} /></CrmField>
          <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Make it the default for this type</label>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save template</button>
        </div>
      </div>
    </>
  );
}
