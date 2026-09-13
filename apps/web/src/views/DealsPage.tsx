import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { api, type Deal, type DealStage } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { NotesPanel } from "../components/NotesPanel.js";
import { CrmTasks } from "../components/CrmTasks.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

export const STAGES: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];

export const STAGE_LABEL: Record<DealStage, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

const STAGE_TONE: Record<DealStage, string> = {
  lead: "bg-slate-400",
  qualified: "bg-sky-500",
  proposal: "bg-indigo-500",
  negotiation: "bg-amber-500",
  won: "bg-emerald-500",
  lost: "bg-red-400",
};

/** The pipeline. Drag a card between columns to change its stage. */
export function DealsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [active, setActive] = useState<Deal | null>(null);

  const { data: columns = [] } = useQuery({ queryKey: ["deal-board"], queryFn: api.getDealBoard });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const move = useMutation({
    mutationFn: ({ id, stage, position }: { id: string; stage: DealStage; position: number }) => api.moveDeal(id, stage, position),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deal-board"] }),
  });

  function onDragStart(e: DragStartEvent) {
    const deal = columns.flatMap((c) => c.deals).find((d) => d.id === e.active.id);
    setActive(deal ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const stage = e.over?.id as DealStage | undefined;
    const deal = columns.flatMap((c) => c.deals).find((d) => d.id === e.active.id);
    if (!stage || !deal || deal.stage === stage) return;
    const column = columns.find((c) => c.stage === stage);
    const position = (column?.deals.reduce((m, d) => Math.max(m, d.position), 0) ?? 0) + 1;

    // Optimistic: move the card now, let the server confirm.
    qc.setQueryData(["deal-board"], (old: typeof columns | undefined) =>
      old?.map((c) => ({
        ...c,
        deals: c.stage === stage
          ? [...c.deals, { ...deal, stage, position }]
          : c.deals.filter((d) => d.id !== deal.id),
      })),
    );
    move.mutate({ id: deal.id, stage, position });
  }

  const openTotal = columns.filter((c) => c.stage !== "won" && c.stage !== "lost").reduce((a, c) => a + c.value, 0);
  const weighted = columns.filter((c) => c.stage !== "won" && c.stage !== "lost").reduce((a, c) => a + c.weighted, 0);

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Deals</h1>
        <span className="text-xs text-muted-foreground">
          Open pipeline <span className="font-medium text-slate-700">{fmtMoney(openTotal)}</span> · weighted{" "}
          <span className="font-medium text-slate-700">{fmtMoney(weighted)}</span>
        </span>
        <button onClick={() => setCreating(true)} className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New deal
        </button>
      </div>

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="flex flex-1 gap-3 overflow-x-auto p-4">
          {columns.map((col) => (
            <Column key={col.stage} stage={col.stage} count={col.count} value={col.value} weighted={col.weighted}>
              {col.deals.map((d) => (
                <DealCard key={d.id} deal={d} onOpen={() => setOpenId(d.id)} />
              ))}
            </Column>
          ))}
        </div>
        <DragOverlay>{active ? <CardBody deal={active} dragging /> : null}</DragOverlay>
      </DndContext>

      {creating && <NewDealDialog onClose={() => setCreating(false)} />}
      {openId && <DealDrawer dealId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function Column({ stage, count, value, weighted, children }: { stage: DealStage; count: number; value: number; weighted: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-64 shrink-0 flex-col rounded-lg border bg-[#fbfbfa] transition",
        isOver ? "border-indigo-400 bg-indigo-50/50" : "border-border",
      )}
    >
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full", STAGE_TONE[stage])} />
          <span className="text-sm font-semibold text-slate-800">{STAGE_LABEL[stage]}</span>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">{count}</span>
        </div>
        <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
          {fmtMoney(value)}
          {stage !== "won" && stage !== "lost" ? ` · ${fmtMoney(weighted)} weighted` : ""}
        </p>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">{children}</div>
    </div>
  );
}

function DealCard({ deal, onOpen }: { deal: Deal; onOpen: () => void }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: deal.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} onClick={onOpen} className={cn(isDragging && "opacity-30")}>
      <CardBody deal={deal} />
    </div>
  );
}

function CardBody({ deal, dragging }: { deal: Deal; dragging?: boolean }) {
  const initials = (deal.owner?.name ?? "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className={cn("cursor-grab rounded-md border border-border bg-white p-2.5 shadow-sm transition hover:border-indigo-300", dragging && "rotate-1 shadow-lg")}>
      <p className="truncate text-sm font-medium text-slate-800">{deal.title}</p>
      <p className="truncate text-xs text-muted-foreground">{deal.company?.name ?? "No company"}</p>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-sm font-semibold tabular-nums text-slate-800">{fmtMoney(deal.value, deal.currency)}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{deal.probability}%</span>
        {deal.project && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">Project</span>}
        <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-700" title={deal.owner?.name}>
          {initials}
        </span>
      </div>
    </div>
  );
}

function NewDealDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [contactId, setContactId] = useState("");
  const [value, setValue] = useState("");
  const [close, setClose] = useState("");
  const { data: contacts = [] } = useQuery({
    queryKey: ["contacts", "company", companyId],
    queryFn: () => api.getContacts({ companyId }),
    enabled: Boolean(companyId),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createDeal({
        title: title.trim(),
        companyId: companyId || null,
        contactId: contactId || null,
        value: value ? Number(value) : 0,
        expectedCloseDate: close ? new Date(close).toISOString() : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal-board"] });
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) create.mutate();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">New deal</h2>
        <div className="mt-4 space-y-3">
          <CrmField label="Title"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required className={input} placeholder="Website redesign for Acme" /></CrmField>
          <CrmField label="Company">
            <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setContactId(""); }} className={input}>
              <option value="">No company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </CrmField>
          {companyId && (
            <CrmField label="Contact">
              <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={input}>
                <option value="">—</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
              </select>
            </CrmField>
          )}
          <div className="grid grid-cols-2 gap-3">
            <CrmField label="Value"><input type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className={input} placeholder="5000" /></CrmField>
            <CrmField label="Expected close"><input type="date" value={close} onChange={(e) => setClose(e.target.value)} className={input} /></CrmField>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!title.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </>
  );
}

/** Side panel for one deal: stage, value, probability, convert-to-project, notes. */
function DealDrawer({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const qc = useQueryClient();
  useEscape(onClose);
  const { role } = useAuth();
  const isAdmin = role === "owner" || role === "admin";
  const { data: deal } = useQuery({ queryKey: ["deal", dealId], queryFn: () => api.getDeal(dealId) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["deal", dealId] });
    qc.invalidateQueries({ queryKey: ["deal-board"] });
  };
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateDeal>[1]) => api.updateDeal(dealId, patch),
    onSuccess: refresh,
  });
  const convert = useMutation({
    mutationFn: () => api.convertDeal(dealId),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["spaces"] });
    },
  });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-screen w-[420px] flex-col border-l border-border bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-xs font-medium text-muted-foreground">Deal</span>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-muted">✕</button>
        </header>
        {deal ? (
          <div className="flex-1 overflow-y-auto">
            <div className="px-5 py-4">
              <h2 className="text-lg font-semibold text-slate-900">{deal.title}</h2>
              <p className="text-sm text-muted-foreground">
                {deal.company ? <Link to="/crm/companies/$companyId" params={{ companyId: deal.company.id }} className="hover:text-indigo-700">{deal.company.name}</Link> : "No company"}
                {deal.contact ? ` · ${deal.contact.name}` : ""}
              </p>

              <div className="mt-4 space-y-2.5">
                <Row label="Stage">
                  <select value={deal.stage} onChange={(e) => update.mutate({ stage: e.target.value as DealStage })} className={input}>
                    {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                  </select>
                </Row>
                <Row label="Value">
                  <input type="number" min="0" step="0.01" defaultValue={deal.value} onBlur={(e) => Number(e.target.value) !== deal.value && update.mutate({ value: Number(e.target.value) })} className={input} />
                </Row>
                <Row label="Probability">
                  <input type="number" min="0" max="100" defaultValue={deal.probability} onBlur={(e) => Number(e.target.value) !== deal.probability && update.mutate({ probability: Number(e.target.value) })} className={input} />
                </Row>
                <Row label="Close date">
                  <input type="date" defaultValue={deal.expectedCloseDate?.slice(0, 10) ?? ""} onBlur={(e) => update.mutate({ expectedCloseDate: e.target.value ? new Date(e.target.value).toISOString() : null })} className={input} />
                </Row>
                {deal.stage === "lost" && (
                  <Row label="Lost reason">
                    <input defaultValue={deal.lostReason ?? ""} onBlur={(e) => update.mutate({ lostReason: e.target.value || null })} className={input} placeholder="Why did we lose it?" />
                  </Row>
                )}
                <Row label="Owner"><span className="text-sm text-slate-700">{deal.owner?.name ?? "—"}</span></Row>
                {deal.closedAt && <Row label="Closed"><span className="text-sm text-slate-700">{fmtShortDate(deal.closedAt)}</span></Row>}
              </div>

              <div className="mt-4 rounded-md border border-border bg-[#fbfbfa] p-3">
                {deal.project ? (
                  <p className="text-sm text-slate-700">
                    Delivered as{" "}
                    <Link to="/projects/$projectId" params={{ projectId: deal.project.id }} className="font-medium text-indigo-600 hover:text-indigo-700">{deal.project.name}</Link>
                  </p>
                ) : isAdmin ? (
                  <div className="flex items-center gap-3">
                    <p className="flex-1 text-xs text-muted-foreground">Create a project from this deal. Marks it won and carries the value over as the budget.</p>
                    <button onClick={() => convert.mutate()} disabled={convert.isPending} className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                      {convert.isPending ? "Converting…" : "Convert to project"}
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">An admin can convert this deal into a project once it is won.</p>
                )}
              </div>
            </div>

            <div className="border-t border-border px-5 py-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tasks</p>
              <CrmTasks link={{ dealId }} compact />
            </div>

            <div className="border-t border-border px-5 py-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</p>
              <NotesPanel entityType="deal" entityId={dealId} />
            </div>
          </div>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">Loading…</p>
        )}
      </aside>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[90px_1fr] items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
