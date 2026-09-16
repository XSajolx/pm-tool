import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ContractKind, type ContractStatus } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { CrmField, input } from "./CompaniesPage.js";
import { useEscape } from "../lib/useEscape.js";
import { cn } from "../lib/utils.js";

export const CONTRACT_STATUS: Record<ContractStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  sent: { label: "Sent", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  viewed: { label: "Viewed", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  signed: { label: "Signed", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  declined: { label: "Declined", cls: "bg-red-50 text-red-700 border-red-200" },
  expired: { label: "Expired", cls: "bg-amber-50 text-amber-700 border-amber-200" },
};

export const KIND_LABEL: Record<ContractKind, string> = {
  service_agreement: "Service agreement",
  nda: "NDA",
  retainer: "Retainer",
  contractor: "Contractor agreement",
  custom: "Custom",
};

/** Row 158: every contract and where it is in the send → view → sign flow. */
export function ContractsPage() {
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("all");
  const { data: contracts = [], isLoading } = useQuery({ queryKey: ["contracts", filter], queryFn: () => api.getContracts({ status: filter }) });
  const awaiting = contracts.filter((c) => c.status === "sent" || c.status === "viewed").length;
  const signed = contracts.filter((c) => c.status === "signed").length;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Contracts</h1>
        <span className="text-xs text-muted-foreground">
          <span className="font-medium text-slate-700">{awaiting}</span> awaiting signature · <span className="font-medium text-slate-700">{signed}</span> signed
        </span>
        <Link to="/settings" className="ml-auto text-xs text-muted-foreground hover:text-indigo-700" title="Contract & proposal templates live in Settings">
          ⚙ Templates
        </Link>
        <button onClick={() => setCreating(true)} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New contract
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="mb-3 flex flex-wrap gap-1">
          {["all", "draft", "sent", "viewed", "signed", "declined", "expired"].map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={cn("rounded-full border px-3 py-1 text-xs font-medium capitalize transition", filter === k ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:bg-muted")}>
              {k}
            </button>
          ))}
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : contracts.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Number</th>
                  <th className="px-4 py-2 text-left font-medium">Title</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-left font-medium">Client</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Signatures</th>
                  <th className="px-4 py-2 text-right font-medium">Fee</th>
                  <th className="px-4 py-2 text-right font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => {
                  const st = CONTRACT_STATUS[c.status];
                  const total = c.signers.length;
                  const done = c.signers.filter((s) => s.signedAt).length;
                  return (
                    <tr key={c.id} className="border-t border-border hover:bg-[#fbfbfa]">
                      <td className="px-4 py-2.5"><Link to="/crm/contracts/$contractId" params={{ contractId: c.id }} className="text-xs font-medium text-indigo-600">{c.number}</Link></td>
                      <td className="px-4 py-2.5"><Link to="/crm/contracts/$contractId" params={{ contractId: c.id }} className="font-medium text-slate-800 hover:text-indigo-700">{c.title}</Link></td>
                      <td className="px-4 py-2.5 text-slate-600">{KIND_LABEL[c.kind]}</td>
                      <td className="px-4 py-2.5 text-slate-600">{c.company?.name ?? c.signers.find((s) => s.role === "client")?.name ?? "—"}</td>
                      <td className="px-4 py-2.5"><span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span></td>
                      <td className="px-4 py-2.5 text-xs text-slate-600">
                        <span className={done === total && total > 0 ? "text-emerald-700" : ""}>{done}/{total}</span>
                        <span className="ml-1.5 text-muted-foreground">{c.signers.map((s) => (s.signedAt ? "✓" : s.viewedAt ? "👁" : "·")).join(" ")}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-800">{c.fields.fee != null ? fmtMoney(c.fields.fee, c.fields.currency ?? "USD") : "—"}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{fmtShortDate(c.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">✍️</span>
            <p className="text-sm text-muted-foreground">{filter === "all" ? "No contracts yet. Start one from a template — service agreement, NDA, retainer or contractor." : "Nothing here."}</p>
          </div>
        )}
      </div>
      {creating && <NewContractDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Pick a template (per service type) and who it is with; the editor opens next. */
export function NewContractDialog({ onClose, dealId, companyId: presetCompany, projectId: presetProject }: { onClose: () => void; dealId?: string; companyId?: string; projectId?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEscape(onClose);
  const { data: templates = [] } = useQuery({ queryKey: ["contract-templates"], queryFn: api.getContractTemplates });
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const [templateId, setTemplateId] = useState("");
  const [companyId, setCompanyId] = useState(presetCompany ?? "");
  const [contactId, setContactId] = useState("");
  const [projectId, setProjectId] = useState(presetProject ?? "");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: contacts = [] } = useQuery({ queryKey: ["contacts", "company", companyId], queryFn: () => api.getContacts({ companyId }), enabled: Boolean(companyId) });
  const chosen = templates.find((t) => t.id === templateId) ?? templates.find((t) => t.isDefault && t.kind === "service_agreement") ?? templates[0];

  const create = useMutation({
    mutationFn: () =>
      api.createContract({
        templateId: chosen?.id ?? null,
        kind: chosen?.kind,
        title: title.trim() || undefined,
        companyId: companyId || undefined,
        contactId: contactId || undefined,
        projectId: projectId || undefined,
        dealId: dealId ?? undefined,
      }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["contracts"] });
      onClose();
      navigate({ to: "/crm/contracts/$contractId", params: { contractId: c.id } });
    },
    onError: (e) => setError((e as Error).message.replace(/^API \d+: /, "")),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }
  const groups = ["service_agreement", "retainer", "nda", "contractor", "custom"] as ContractKind[];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">New contract</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Starts as a draft from a template. Placeholders like {"{{client}}"} and {"{{fee}}"} are filled in when you send.</p>
        <div className="mt-4 grid max-h-52 grid-cols-2 gap-2 overflow-y-auto pr-1">
          {groups.flatMap((k) => templates.filter((t) => t.kind === k)).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTemplateId(t.id)}
              className={cn("rounded-md border px-3 py-2 text-left transition", chosen?.id === t.id ? "border-indigo-400 bg-indigo-50" : "border-border hover:bg-muted")}
            >
              <p className="text-sm font-medium text-slate-800">{t.name}{t.isDefault && <span className="ml-1 text-[10px] text-indigo-600">default</span>}</p>
              <p className="text-[11px] text-muted-foreground">{KIND_LABEL[t.kind]}{t.description ? ` · ${t.description}` : ""}</p>
            </button>
          ))}
          {!templates.length && <p className="col-span-2 text-xs text-muted-foreground">Loading templates…</p>}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <CrmField label="Client company">
            <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setContactId(""); }} className={input}>
              <option value="">—</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </CrmField>
          <CrmField label="Signs for the client">
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} disabled={!companyId} className={input}>
              <option value="">{companyId ? "Primary contact" : "Pick a company first"}</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
            </select>
          </CrmField>
          <CrmField label="Project (optional)">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input}>
              <option value="">—</option>
              {projects.filter((p) => p.kind !== "internal" && (!companyId || !p.companyId || p.companyId === companyId)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </CrmField>
          <CrmField label="Title (optional)"><input value={title} onChange={(e) => setTitle(e.target.value)} className={input} placeholder={chosen ? `${chosen.name} — client` : ""} /></CrmField>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">Contractor agreements: leave the company empty and add the freelancer as a signer on the next screen.</p>
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!chosen || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create draft"}
          </button>
        </div>
      </form>
    </>
  );
}
