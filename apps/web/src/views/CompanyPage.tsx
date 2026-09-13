import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { NotesPanel } from "../components/NotesPanel.js";
import { CrmTasks } from "../components/CrmTasks.js";
import { NotFound } from "../components/NotFound.js";
import { STAGE_LABEL } from "./DealsPage.js";
import { cn } from "../lib/utils.js";

type Tab = "contacts" | "deals" | "tasks" | "estimates" | "notes";

/** One company: details, its people, its pipeline, its paperwork, its notes. */
export function CompanyPage() {
  const { companyId } = useParams({ from: "/crm/companies/$companyId" });
  const [tab, setTab] = useState<Tab>("contacts");

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

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Link to="/crm/companies" className="text-sm text-muted-foreground hover:text-slate-700">Companies</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-sm font-semibold text-slate-800">{company.name}</h1>
        {company.industry && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-slate-600">{company.industry}</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-white p-4 text-sm lg:grid-cols-4">
          <Info label="Owner" value={company.owner?.name} />
          <Info label="Email" value={company.email} />
          <Info label="Phone" value={company.phone} />
          <Info label="Website" value={company.website} />
        </div>

        <div className="mt-5 flex gap-1 border-b border-border">
          {(["contacts", "deals", "tasks", "estimates", "notes"] as Tab[]).map((t) => (
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
              {t === "tasks" && openTasks ? ` (${openTasks})` : ""}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "contacts" && (
            contacts.length ? (
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {contacts.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
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
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No contacts at this company yet." link={{ to: "/crm/contacts", label: "Add one in Contacts" }} />
            )
          )}

          {tab === "deals" && (
            deals.length ? (
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {deals.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{d.title}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-slate-600">{STAGE_LABEL[d.stage]}</span>
                    <span className="w-24 text-right text-sm tabular-nums text-slate-700">{fmtMoney(d.value, d.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No deals with this company." link={{ to: "/crm/deals", label: "Open the pipeline" }} />
            )
          )}

          {tab === "tasks" && <CrmTasks link={{ companyId }} />}

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

          {tab === "notes" && <NotesPanel entityType="company" entityId={companyId} />}
        </div>
      </div>
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
