import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Contact } from "../lib/api.js";
import { CrmField, input } from "../views/CompaniesPage.js";
import { useAuth } from "../lib/auth.js";

/**
 * Row 52: one dialog for creating and editing a contact — name, company, job
 * title, email, phone and the primary-contact flag (one per company; the
 * server demotes the previous primary).
 */
export function ContactDialog({ contact, defaultCompanyId, onClose }: { contact?: Contact; defaultCompanyId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { role } = useAuth();
  const canDelete = role === "owner" || role === "admin";
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const [firstName, setFirstName] = useState(contact?.firstName ?? "");
  const [lastName, setLastName] = useState(contact?.lastName ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [title, setTitle] = useState(contact?.title ?? "");
  const [companyId, setCompanyId] = useState(contact?.company?.id ?? defaultCompanyId ?? "");
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["contacts"] });
    qc.invalidateQueries({ queryKey: ["companies"] });
    qc.invalidateQueries({ queryKey: ["company"] });
  };
  const body = () => ({
    firstName: firstName.trim(),
    lastName: lastName.trim() || undefined,
    email: email.trim() || undefined,
    phone: phone.trim() || undefined,
    title: title.trim() || undefined,
    companyId: companyId || null,
    isPrimary,
  });
  const save = useMutation({
    mutationFn: () => (contact ? api.updateContact(contact.id, body()) : api.createContact(body())),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.archiveContact(contact!.id),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (firstName.trim() && !save.isPending) save.mutate();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">{contact ? "Edit contact" : "New contact"}</h2>
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <CrmField label="First name">
              <input autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} required className={input} />
            </CrmField>
            <CrmField label="Last name">
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={input} />
            </CrmField>
          </div>
          <CrmField label="Company">
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={input}>
              <option value="">No company</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Job title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={input} placeholder="Head of Marketing" />
          </CrmField>
          <div className="grid grid-cols-2 gap-3">
            <CrmField label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
            </CrmField>
            <CrmField label="Phone">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className={input} />
            </CrmField>
          </div>
          {companyId && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="accent-indigo-600" />
              Primary contact for this company
            </label>
          )}
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex items-center gap-2">
          {contact && canDelete && (
            <button
              type="button"
              onClick={() => window.confirm(`Remove ${contact.fullName}? They will disappear from lists but stay on past records.`) && remove.mutate()}
              disabled={remove.isPending}
              className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              Remove
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">
              Cancel
            </button>
            <button type="submit" disabled={!firstName.trim() || save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {save.isPending ? "Saving…" : contact ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
