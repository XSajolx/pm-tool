import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { fmtMoney } from "../lib/format.js";

export const input =
  "w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

export function CrmField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}

/** Companies table with search and quick create. */
export function CompaniesPage() {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const { data: companies = [], isLoading } = useQuery({
    queryKey: ["companies", q],
    queryFn: () => api.getCompanies(q.trim() || undefined),
  });

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Companies</h1>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="ml-2 w-56 rounded-md border border-border bg-white px-2.5 py-1 text-sm outline-none focus:border-indigo-500"
        />
        <button
          onClick={() => setCreating(true)}
          className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          New company
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : companies.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#fbfbfa] text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Company</th>
                  <th className="px-4 py-2 text-left font-medium">Industry</th>
                  <th className="px-4 py-2 text-left font-medium">Owner</th>
                  <th className="px-4 py-2 text-right font-medium">Contacts</th>
                  <th className="px-4 py-2 text-right font-medium">Open deals</th>
                  <th className="px-4 py-2 text-right font-medium">Won</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-[#fbfbfa]">
                    <td className="px-4 py-2.5">
                      <Link to="/crm/companies/$companyId" params={{ companyId: c.id }} className="font-medium text-slate-800 hover:text-indigo-700">
                        {c.name}
                      </Link>
                      {c.website && <p className="text-xs text-muted-foreground">{c.website}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{c.industry ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600">{c.owner?.name ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{c.contactCount ?? 0}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{c.openDeals ?? 0}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {c.wonValue ? fmtMoney(c.wonValue) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">🏢</span>
            <p className="text-sm text-muted-foreground">{q ? "No companies match." : "No companies yet."}</p>
          </div>
        )}
      </div>

      {creating && <NewCompanyDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewCompanyDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createCompany({
        name: name.trim(),
        industry: industry.trim() || undefined,
        website: website.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">New company</h2>
        <div className="mt-4 space-y-3">
          <CrmField label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required className={input} /></CrmField>
          <div className="grid grid-cols-2 gap-3">
            <CrmField label="Industry"><input value={industry} onChange={(e) => setIndustry(e.target.value)} className={input} /></CrmField>
            <CrmField label="Website"><input value={website} onChange={(e) => setWebsite(e.target.value)} className={input} placeholder="acme.com" /></CrmField>
            <CrmField label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} /></CrmField>
            <CrmField label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} className={input} /></CrmField>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </>
  );
}
