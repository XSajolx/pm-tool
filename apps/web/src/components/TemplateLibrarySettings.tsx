import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ContractKind, type ContractTemplate, type ProposalSection, type ProposalTemplate } from "../lib/api.js";
import { ProposalSectionsEditor } from "./ProposalSections.js";
import { cn } from "../lib/utils.js";

const KINDS: { key: ContractKind; label: string; blurb: string }[] = [
  { key: "service_agreement", label: "Service agreements", blurb: "Project work for a client" },
  { key: "retainer", label: "Retainers", blurb: "Ongoing monthly engagements" },
  { key: "nda", label: "NDAs", blurb: "Confidentiality before sharing details" },
  { key: "contractor", label: "Contractor agreements", blurb: "Hiring a freelancer" },
  { key: "custom", label: "Other", blurb: "Anything else" },
];

const PLACEHOLDERS: [string, string][] = [
  ["{{client}}", "Client company"],
  ["{{client_address}}", "Client address"],
  ["{{contact}}", "Signer / contact"],
  ["{{contact_email}}", "Contact email"],
  ["{{our_company}}", "Our company"],
  ["{{project}}", "Project"],
  ["{{fee}}", "Fee / total"],
  ["{{currency}}", "Currency"],
  ["{{start_date}}", "Start date"],
  ["{{end_date}}", "End date"],
  ["{{date}}", "Send date"],
  ["{{number}}", "Number"],
  ["{{title}}", "Title"],
];

/**
 * Row 159: one library for contract and proposal templates. Contract
 * templates are grouped by service type with one default per type, so a new
 * agreement starts from the right text in a click.
 */
export function TemplateLibrarySettings({ canEdit }: { canEdit: boolean }) {
  const [tab, setTab] = useState<"contracts" | "proposals">("contracts");
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Contract & proposal templates</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Reusable text with merge fields. Contracts keep one default per service type; proposals keep one overall default. Any contract or proposal can be saved back here with “Save as template”.
      </p>
      <div className="mt-4 flex gap-1 rounded-md bg-muted p-1 text-xs font-medium">
        {([["contracts", "Contracts"], ["proposals", "Proposals"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn("flex-1 rounded px-2 py-1 transition", tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>{label}</button>
        ))}
      </div>
      <PlaceholderChips />
      {tab === "contracts" ? <ContractTemplates canEdit={canEdit} /> : <ProposalTemplates canEdit={canEdit} />}
    </div>
  );
}

function PlaceholderChips() {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <span className="mr-1">Merge fields (click to copy):</span>
      {PLACEHOLDERS.map(([ph, hint]) => (
        <button key={ph} type="button" title={hint} onClick={() => { void navigator.clipboard?.writeText(ph); setCopied(ph); setTimeout(() => setCopied(null), 1200); }} className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px]", copied === ph ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-border bg-white text-slate-600 hover:bg-muted")}>{ph}</button>
      ))}
    </div>
  );
}

/* ---------------- contracts ---------------- */

function ContractTemplates({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ["contract-templates"], queryFn: api.getContractTemplates });
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ContractKind>("service_agreement");
  const refresh = () => qc.invalidateQueries({ queryKey: ["contract-templates"] });
  const create = useMutation({
    mutationFn: () => api.createContractTemplate({ name: name.trim(), kind, sections: [{ key: "parties", title: "Parties", body: "This agreement is made on {{date}} between {{our_company}} and {{client}}, represented by {{contact}}." }, { key: "terms", title: "Terms", body: "" }] }),
    onSuccess: (t) => { setName(""); setOpenId(t.id); refresh(); },
  });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateContractTemplate>[1] }) => api.updateContractTemplate(id, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteContractTemplate(id), onSuccess: refresh });

  return (
    <div className="mt-5 space-y-6">
      {KINDS.map((k) => {
        const rows = templates.filter((t) => t.kind === k.key);
        if (!rows.length && k.key === "custom") return null;
        return (
          <section key={k.key}>
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-slate-800">{k.label}</h2>
              <span className="text-xs text-muted-foreground">{k.blurb}</span>
              {!rows.some((t) => t.isDefault) && rows.length > 0 && <span className="text-[11px] text-amber-700">no default — new contracts of this type pick the first</span>}
            </div>
            {rows.length ? (
              <ul className="space-y-2">
                {rows.map((t) => (
                  <ContractTemplateRow key={t.id} template={t} open={openId === t.id} canEdit={canEdit} onToggle={() => setOpenId(openId === t.id ? null : t.id)} onSave={(b) => update.mutate({ id: t.id, body: b })} onDelete={() => remove.mutate(t.id)} />
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">None yet.</p>
            )}
          </section>
        );
      })}
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="flex flex-wrap gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New template, e.g. Website build SA" className="min-w-0 flex-1 rounded-md border border-border px-3 py-1.5 text-sm outline-none focus:border-indigo-500" />
          <select value={kind} onChange={(e) => setKind(e.target.value as ContractKind)} className="rounded-md border border-border px-2 py-1.5 text-sm">
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Add template</button>
        </form>
      )}
    </div>
  );
}

function ContractTemplateRow({ template, open, canEdit, onToggle, onSave, onDelete }: { template: ContractTemplate; open: boolean; canEdit: boolean; onToggle: () => void; onSave: (b: Parameters<typeof api.updateContractTemplate>[1]) => void; onDelete: () => void }) {
  const [sections, setSections] = useState<ProposalSection[]>(template.sections);
  const [description, setDescription] = useState(template.description ?? "");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setSections(template.sections);
    setDescription(template.description ?? "");
  }, [template]);
  const dirty = JSON.stringify(sections) !== JSON.stringify(template.sections) || description !== (template.description ?? "");
  return (
    <li className="rounded-lg border border-border bg-white">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <button type="button" onClick={onToggle} className="text-xs text-slate-400">{open ? "▾" : "▸"}</button>
        <InlineName value={template.name} disabled={!canEdit} onCommit={(v) => onSave({ name: v })} />
        <span className="text-xs text-muted-foreground">{template.sections.length} sections</span>
        {template.isDefault ? (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">Default for this type</span>
        ) : (
          canEdit && <button type="button" onClick={() => onSave({ isDefault: true })} className="text-[11px] text-slate-500 hover:text-indigo-700">Make default</button>
        )}
        {canEdit && (
          <select value={template.kind} onChange={(e) => onSave({ kind: e.target.value as ContractKind })} className="ml-auto rounded border border-border px-1.5 py-0.5 text-[11px] text-slate-600" title="Move to another type">
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        )}
        {canEdit && !confirm && <button type="button" onClick={() => setConfirm(true)} className="text-xs text-slate-400 hover:text-red-600">Delete</button>}
        {canEdit && confirm && (
          <span className="flex items-center gap-1 text-xs">
            <button type="button" onClick={onDelete} className="rounded bg-red-600 px-2 py-0.5 text-white">Confirm delete</button>
            <button type="button" onClick={() => setConfirm(false)} className="text-slate-500">Cancel</button>
          </span>
        )}
      </div>
      {open && (
        <div className="border-t border-border bg-[#fbfbfa] p-3">
          <input value={description} disabled={!canEdit} onChange={(e) => setDescription(e.target.value)} placeholder="One-line description shown when picking a template" className="mb-3 w-full rounded-md border border-border bg-white px-3 py-1.5 text-xs outline-none focus:border-indigo-500" />
          <ProposalSectionsEditor sections={sections} onChange={setSections} disabled={!canEdit} />
          {canEdit && dirty && (
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => { setSections(template.sections); setDescription(template.description ?? ""); }} className="rounded-md px-3 py-1.5 text-xs text-slate-600 hover:bg-muted">Discard</button>
              <button type="button" onClick={() => onSave({ sections, description: description || null })} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/* ---------------- proposals (row 56, moved here) ---------------- */

function ProposalTemplates({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ["proposal-templates"], queryFn: api.getProposalTemplates });
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["proposal-templates"] });
  const create = useMutation({ mutationFn: () => api.createProposalTemplate({ name }), onSuccess: (t) => { setName(""); setOpenId(t.id); refresh(); } });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateProposalTemplate>[1] }) => api.updateProposalTemplate(id, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteProposalTemplate(id), onSuccess: refresh });
  return (
    <div className="mt-5">
      <p className="mb-2 text-xs text-muted-foreground">Each template is a fixed set of sections — scope, milestones, timeline, exclusions, assumptions, terms. Merge fields are filled in when the proposal is sent.</p>
      <ul className="space-y-2">
        {templates.map((t) => (
          <ProposalTemplateRow key={t.id} template={t} open={openId === t.id} canEdit={canEdit} onToggle={() => setOpenId(openId === t.id ? null : t.id)} onSave={(b) => update.mutate({ id: t.id, body: b })} onDelete={() => remove.mutate(t.id)} />
        ))}
      </ul>
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="mt-3 flex gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New template, e.g. Retainer proposal" className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm outline-none focus:border-indigo-500" />
          <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Add template</button>
        </form>
      )}
    </div>
  );
}

function ProposalTemplateRow({ template, open, canEdit, onToggle, onSave, onDelete }: { template: ProposalTemplate; open: boolean; canEdit: boolean; onToggle: () => void; onSave: (b: Parameters<typeof api.updateProposalTemplate>[1]) => void; onDelete: () => void }) {
  const [sections, setSections] = useState(template.sections);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setSections(template.sections), [template]);
  const dirty = JSON.stringify(sections) !== JSON.stringify(template.sections);
  return (
    <li className="rounded-lg border border-border bg-white">
      <div className="flex items-center gap-3 px-3 py-2">
        <button type="button" onClick={onToggle} className="text-xs text-slate-400">{open ? "▾" : "▸"}</button>
        <InlineName value={template.name} disabled={!canEdit} onCommit={(v) => onSave({ name: v })} />
        <span className="text-xs text-muted-foreground">{template.sections.length} sections</span>
        {template.isDefault ? (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">Default</span>
        ) : (
          canEdit && <button type="button" onClick={() => onSave({ isDefault: true })} className="text-[11px] text-slate-500 hover:text-indigo-700">Make default</button>
        )}
        {canEdit && !confirm && <button type="button" onClick={() => setConfirm(true)} className="ml-auto text-xs text-slate-400 hover:text-red-600">Delete</button>}
        {canEdit && confirm && (
          <span className="ml-auto flex items-center gap-1 text-xs">
            <button type="button" onClick={onDelete} className="rounded bg-red-600 px-2 py-0.5 text-white">Confirm delete</button>
            <button type="button" onClick={() => setConfirm(false)} className="text-slate-500">Cancel</button>
          </span>
        )}
      </div>
      {open && (
        <div className="border-t border-border bg-[#fbfbfa] p-3">
          <ProposalSectionsEditor sections={sections} onChange={setSections} disabled={!canEdit} />
          {canEdit && dirty && (
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setSections(template.sections)} className="rounded-md px-3 py-1.5 text-xs text-slate-600 hover:bg-muted">Discard</button>
              <button type="button" onClick={() => onSave({ sections })} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save sections</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function InlineName({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() && text.trim() !== value && onCommit(text.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="min-w-0 flex-1 bg-transparent text-sm font-medium text-slate-800 outline-none disabled:opacity-80"
    />
  );
}
