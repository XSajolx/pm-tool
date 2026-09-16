import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Company, type CompanyInput, type Contact } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { PROJECT_STATUS } from "./ProjectsPage.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { NotesPanel } from "../components/NotesPanel.js";
import { CrmTasks } from "../components/CrmTasks.js";
import { ContactDialog } from "../components/ContactDialog.js";
import { DocsTab } from "../components/DocsTab.js";
import { LinkedFiles } from "../components/LinkedFiles.js";
import { NotFound } from "../components/NotFound.js";
import { BillingTab } from "../components/BillingTab.js";
import { cn } from "../lib/utils.js";

type Tab = "contacts" | "projects" | "deals" | "tasks" | "docs" | "estimates" | "billing" | "notes";

/** One company: details, its people, its pipeline, its paperwork, its notes. */
export function CompanyPage() {
  const { companyId } = useParams({ from: "/crm/companies/$companyId" });
  const [tab, setTab] = useState<Tab>("contacts");
  const [contactDialog, setContactDialog] = useState<"new" | Contact | null>(null);

  const { data: company, isError } = useQuery({ queryKey: ["company", companyId], queryFn: () => api.getCompany(companyId) });
  const { data: estimates = [] } = useQuery({
    queryKey: ["estimates", "company", companyId],
    queryFn: () => api.getEstimates({ companyId }),
    enabled: tab === "estimates",
  });
  // Open follow-ups count for the tab label (row 38).
  const { data: crmTasks = [] } = useQuery({ queryKey: ["crm-tasks", { companyId }], queryFn: () => api.getCrmTasks({ companyId }) });
  const openTasks = crmTasks.filter((t) => t.status?.category !== "done").length;

  if (isError) return <NotFound what="company" />;
  if (!company) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  const contacts = company.contacts ?? [];
  const deals = company.deals ?? [];
  const projects = company.projects ?? [];

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/crm/companies" className="text-sm text-muted-foreground hover:text-slate-700">Companies</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-sm font-semibold text-slate-800">{company.name}</h1>
        {company.industry && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-slate-600">{company.industry}</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <CompanyDetails company={company} />

        <div className="mt-5 flex gap-1 border-b border-border">
          {(["contacts", "projects", "deals", "tasks", "docs", "estimates", "billing", "notes"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize transition",
                tab === t ? "border-indigo-600 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700",
              )}
            >
              {t}
              {t === "contacts" && contacts.length ? ` (${contacts.length})` : ""}
              {t === "deals" && deals.length ? ` (${deals.length})` : ""}
              {t === "projects" && projects.length ? ` (${projects.length})` : ""}
              {t === "tasks" && openTasks ? ` (${openTasks})` : ""}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "contacts" && (
            <div className="mb-3 flex justify-end">
              <button type="button" onClick={() => setContactDialog("new")} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
                + Add contact
              </button>
            </div>
          )}
          {tab === "contacts" && (
            contacts.length ? (
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {contacts.map((c) => (
                  <li key={c.id} onClick={() => setContactDialog(c)} className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-2.5 hover:bg-[#fbfbfa] last:border-b-0" title="Edit contact">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700">
                      {(c.firstName[0] ?? "") + (c.lastName?.[0] ?? "")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800">
                        {[c.firstName, c.lastName].filter(Boolean).join(" ")}
                        {c.isPrimary && <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">Primary</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{[c.title, c.email, c.phone].filter(Boolean).join(" · ") || "—"}</p>
                    </div>
                    {c.email && (
                      <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()} className="rounded-md border border-border px-2 py-0.5 text-[11px] text-slate-600 hover:text-indigo-700">
                        Email
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No contacts at this company yet." link={{ to: "/crm/contacts", label: "Or manage all contacts" }} />
            )
          )}

          {tab === "projects" && (
            projects.length ? (
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {projects.map((p) => (
                  <li key={p.id}>
                    <Link to="/projects/$projectId" params={{ projectId: p.id }} className="flex items-center gap-3 border-b border-border px-4 py-2.5 hover:bg-[#fbfbfa] last:border-b-0">
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: p.color }} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{p.name}</span>
                      {p.lead && <span className="text-xs text-muted-foreground">{p.lead.name}</span>}
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", PROJECT_STATUS[p.status].cls)}>{PROJECT_STATUS[p.status].label}</span>
                      <span className="w-40 text-right text-xs text-muted-foreground">
                        {p.startDate || p.endDate ? `${p.startDate ? fmtShortDate(p.startDate) : "…"} → ${p.endDate ? fmtShortDate(p.endDate) : "…"}` : ""}
                      </span>
                      {p.budgetAmount != null && <span className="w-24 text-right text-sm tabular-nums text-slate-700">{fmtMoney(p.budgetAmount, p.currency)}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No projects for this client yet." link={{ to: "/projects", label: "Create one in Projects" }} />
            )
          )}

          {tab === "deals" && (
            deals.length ? (
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {deals.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{d.title}</span>
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `${d.stage?.color ?? "#94a3b8"}22`, color: d.stage?.color ?? "#475569" }}>{d.stage?.name ?? "—"}</span>
                    <span className="w-24 text-right text-sm tabular-nums text-slate-700">{fmtMoney(d.value, d.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No deals with this company." link={{ to: "/crm/deals", label: "Open the pipeline" }} />
            )
          )}

          {tab === "tasks" && <CrmTasks link={{ companyId }} />}

          {tab === "docs" && (
            <>
              <DocsTab entityType="company" entityId={companyId} />
              {/* Row 124 */}
              <div className="mt-4"><LinkedFiles entityType="company" entityId={companyId} /></div>
            </>
          )}

          {tab === "estimates" && (
            estimates.length ? (
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {estimates.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
                    <Link to="/crm/estimates/$estimateId" params={{ estimateId: e.id }} className="text-xs font-medium text-indigo-600">{e.number}</Link>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{e.title}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium capitalize text-slate-600">{e.status}</span>
                    <span className="w-24 text-right text-sm tabular-nums text-slate-700">{fmtMoney(e.total, e.currency)}</span>
                    <span className="w-16 text-right text-xs text-muted-foreground">{e.issueDate ? fmtShortDate(e.issueDate) : ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No estimates for this company." link={{ to: "/crm/estimates", label: "Create one" }} />
            )
          )}

          {tab === "billing" && <BillingTab companyId={companyId} />}
          {tab === "notes" && <NotesPanel entityType="company" entityId={companyId} />}
        </div>
      </div>
      {contactDialog === "new" && <ContactDialog defaultCompanyId={companyId} onClose={() => setContactDialog(null)} />}
      {contactDialog && contactDialog !== "new" && <ContactDialog contact={contactDialog} onClose={() => setContactDialog(null)} />}
    </div>
  );
}

/**
 * Row 51: the client record itself — owner, industry, website, email, phone,
 * address — editable in place by anyone who can manage the CRM.
 */
function CompanyDetails({ company }: { company: Company }) {
  const qc = useQueryClient();
  const { role } = useAuth();
  const canEdit = role === "owner" || role === "admin" || role === "member";
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const save = useMutation({
    mutationFn: (patch: Partial<CompanyInput>) => api.updateCompany(company.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company", company.id] });
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
  });
  const field = "w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm text-slate-800 outline-none hover:border-border focus:border-indigo-500 focus:bg-white disabled:hover:border-transparent";
  const commit = (key: keyof CompanyInput) => (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const v = e.target.value.trim();
    if ((company[key as keyof Company] ?? "") !== v) save.mutate({ [key]: v || undefined } as Partial<CompanyInput>);
  };
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-white p-4 text-sm lg:grid-cols-4">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Owner</p>
        <select value={company.owner?.id ?? ""} disabled={!canEdit} onChange={(e) => save.mutate({ ownerId: e.target.value || null })} className={`${field} mt-0.5`}>
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Industry</p>
        <input defaultValue={company.industry ?? ""} disabled={!canEdit} onBlur={commit("industry")} placeholder="—" className={`${field} mt-0.5`} />
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Website</p>
        <input defaultValue={company.website ?? ""} disabled={!canEdit} onBlur={commit("website")} placeholder="—" className={`${field} mt-0.5`} />
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Email</p>
        <input defaultValue={company.email ?? ""} disabled={!canEdit} onBlur={commit("email")} placeholder="—" className={`${field} mt-0.5`} />
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Phone</p>
        <input defaultValue={company.phone ?? ""} disabled={!canEdit} onBlur={commit("phone")} placeholder="—" className={`${field} mt-0.5`} />
      </div>
      <div className="col-span-2 lg:col-span-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Address</p>
        <textarea defaultValue={company.address ?? ""} disabled={!canEdit} onBlur={commit("address")} rows={1} placeholder="—" className={`${field} mt-0.5 resize-y`} />
      </div>
      {save.isError && <p className="col-span-full text-xs text-red-600">Could not save: {(save.error as Error).message}</p>}
    </div>
  );
}

function Info({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-slate-800">{value || "—"}</p>
    </div>
  );
}

function Empty({ text, link }: { text: string; link: { to: string; label: string } }) {
  return (
    <div className="rounded-lg border border-dashed border-border py-8 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      <Link to={link.to} className="mt-1 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-700">{link.label}</Link>
    </div>
  );
}
