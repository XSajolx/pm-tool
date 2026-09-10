import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { CrmField, input } from "./CompaniesPage.js";

/** People. Each optionally belongs to a company; one per company can be primary. */
export function ContactsPage() {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ["contacts", q],
    queryFn: () => api.getContacts({ q: q.trim() || undefined }),
  });

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Contacts</h1>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="ml-2 w-56 rounded-md border border-border bg-white px-2.5 py-1 text-sm outline-none focus:border-indigo-500"
        />
        <button onClick={() => setCreating(true)} className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New contact
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : contacts.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">Company</th>
                  <th className="px-4 py-2 text-left font-medium">Title</th>
                  <th className="px-4 py-2 text-left font-medium">Email</th>
                  <th className="px-4 py-2 text-left font-medium">Phone</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-[#fbfbfa]">
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-slate-800">{c.fullName}</span>
                      {c.isPrimary && <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">Primary</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {c.company ? (
                        <Link to="/crm/companies/$companyId" params={{ companyId: c.company.id }} className="hover:text-indigo-700">{c.company.name}</Link>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{c.title ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600">{c.email ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600">{c.phone ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">👤</span>
            <p className="text-sm text-muted-foreground">{q ? "No contacts match." : "No contacts yet."}</p>
          </div>
        )}
      </div>

      {creating && <NewContactDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewContactDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createContact({
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        title: title.trim() || undefined,
        companyId: companyId || null,
        isPrimary,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["company"] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (firstName.trim()) create.mutate();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">New contact</h2>
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <CrmField label="First name"><input autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} required className={input} /></CrmField>
            <CrmField label="Last name"><input value={lastName} onChange={(e) => setLastName(e.target.value)} className={input} /></CrmField>
          </div>
          <CrmField label="Company">
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={input}>
              <option value="">No company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </CrmField>
          <CrmField label="Job title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={input} /></CrmField>
          <div className="grid grid-cols-2 gap-3">
            <CrmField label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} /></CrmField>
            <CrmField label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} className={input} /></CrmField>
          </div>
          {companyId && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="accent-indigo-600" />
              Primary contact for this company
            </label>
          )}
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!firstName.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </>
  );
}
