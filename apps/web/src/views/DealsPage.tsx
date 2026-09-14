import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
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
import { api, type Deal, type DealStageRow } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtMoney, fmtShortDate } from "../lib/format.js";
import { NotesPanel } from "../components/NotesPanel.js";
import { CrmTasks } from "../components/CrmTasks.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

/** Row 53: stages come from Settings → Deal stages; won/lost are marked by `kind`. */
export const STAGE_TONE: Record<DealStageRow["kind"], string> = {
  open: "bg-indigo-500",
  won: "bg-emerald-500",
  lost: "bg-red-400",
};

/** The pipeline. Drag a card between columns to change its stage. */
const STALE_KEY = "pm:dealStaleDays";

export function DealsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { deal?: string };
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(search.deal ?? null);
  const [active, setActive] = useState<Deal | null>(null);
  // Row 55: how long a deal may sit untouched before it's flagged. Per person, remembered locally.
  const [staleDays, setStaleDays] = useState(() => {
    try {
      return Number(localStorage.getItem(STALE_KEY)) || 14;
    } catch {
      return 14;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(STALE_KEY, String(staleDays));
    } catch {
      /* ignore */
    }
  }, [staleDays]);
  useEffect(() => {
    if (search.deal) setOpenId(search.deal);
  }, [search.deal]);

  const { data: columns = [] } = useQuery({ queryKey: ["deal-board", staleDays], queryFn: () => api.getDealBoard(staleDays) });
  const staleCount = columns.flatMap((c) => c.deals).filter((d) => d.stale).length;
  const dueCount = columns.flatMap((c) => c.deals).filter((d) => d.followUpDue).length;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const move = useMutation({
    mutationFn: ({ id, stageId, position }: { id: string; stageId: string; position: number }) => api.moveDeal(id, stageId, position),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deal-board"] }),
  });

  function onDragStart(e: DragStartEvent) {
    const deal = columns.flatMap((c) => c.deals).find((d) => d.id === e.active.id);
    setActive(deal ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const stageId = e.over?.id as string | undefined;
    const deal = columns.flatMap((c) => c.deals).find((d) => d.id === e.active.id);
    if (!stageId || !deal || deal.stageId === stageId) return;
    const column = columns.find((c) => c.stage.id === stageId);
    if (!column) return;
    const position = (column.deals.reduce((m, d) => Math.max(m, d.position), 0) ?? 0) + 1;

    // Optimistic: move the card now, let the server confirm.
    qc.setQueryData(["deal-board"], (old: typeof columns | undefined) =>
      old?.map((c) => ({
        ...c,
        deals: c.stage.id === stageId
          ? [...c.deals, { ...deal, stageId, stage: { id: column.stage.id, name: column.stage.name, kind: column.stage.kind, color: column.stage.color }, position }]
          : c.deals.filter((d) => d.id !== deal.id),
      })),
    );
    move.mutate({ id: deal.id, stageId, position });
  }

  const openTotal = columns.filter((c) => c.stage.kind === "open").reduce((a, c) => a + c.value, 0);
  const weighted = columns.filter((c) => c.stage.kind === "open").reduce((a, c) => a + c.weighted, 0);

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Deals</h1>
        <span className="text-xs text-muted-foreground">
          Open pipeline <span className="font-medium text-slate-700">{fmtMoney(openTotal)}</span> · weighted{" "}
          <span className="font-medium text-slate-700">{fmtMoney(weighted)}</span>
        </span>
        {(staleCount > 0 || dueCount > 0) && (
          <span className="text-xs">
            {dueCount > 0 && <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-700">⏰ {dueCount} follow-up{dueCount === 1 ? "" : "s"} due</span>}
            {staleCount > 0 && <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">💤 {staleCount} stale</span>}
          </span>
        )}
        <label className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground" title="Open deals with no activity for this long are flagged stale">
          Stale after
          <input type="number" min={1} max={365} value={staleDays} onChange={(e) => setStaleDays(Math.max(1, Number(e.target.value) || 14))} className="w-12 rounded-md border border-border px-1 py-0.5 text-[11px] text-slate-700" />
          days
        </label>
        <Link to="/settings" className="text-xs text-muted-foreground hover:text-indigo-700" title="Rename, reorder or add stages in Settings → Deal stages">
          ⚙ Stages
        </Link>
        <button onClick={() => setCreating(true)} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New deal
        </button>
      </div>

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="flex flex-1 gap-3 overflow-x-auto p-4">
          {columns.map((col) => (
            <Column key={col.stage.id} stage={col.stage} count={col.count} value={col.value} weighted={col.weighted}>
              {col.deals.map((d) => (
                <DealCard key={d.id} deal={d} onOpen={() => setOpenId(d.id)} />
              ))}
            </Column>
          ))}
        </div>
        <DragOverlay>{active ? <CardBody deal={active} dragging /> : null}</DragOverlay>
      </DndContext>

      {creating && <NewDealDialog onClose={() => setCreating(false)} />}
      {openId && (
        <DealDrawer
          dealId={openId}
          onClose={() => {
            setOpenId(null);
            if (search.deal) navigate({ to: "/crm/deals", search: {} });
          }}
        />
      )}
    </div>
  );
}

function Column({ stage, count, value, weighted, children }: { stage: DealStageRow; count: number; value: number; weighted: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
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
          <span className="h-2 w-2 rounded-full" style={{ background: stage.color }} />
          <span className="text-sm font-semibold text-slate-800">{stage.name}</span>
          {stage.kind !== "open" && <span className={cn("rounded px-1 text-[9px] font-semibold uppercase text-white", STAGE_TONE[stage.kind])}>{stage.kind}</span>}
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">{count}</span>
        </div>
        <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
          {fmtMoney(value)}
          {stage.kind === "open" ? ` · ${fmtMoney(weighted)} weighted` : ""}
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
      {(deal.followUpDue || deal.stale || deal.nextActionAt) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
          {deal.nextActionAt && (
            <span className={cn("rounded px-1.5 py-0.5 font-medium", deal.followUpDue ? "bg-red-50 text-red-700" : "bg-sky-50 text-sky-700")} title={deal.nextActionNote ?? "Next action"}>
              ⏰ {fmtShortDate(deal.nextActionAt)}
              {deal.nextActionNote ? ` · ${deal.nextActionNote}` : ""}
            </span>
          )}
          {deal.stale && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800" title="No activity for a while">
              💤 {deal.idleDays}d idle
            </span>
          )}
        </div>
      )}
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
  const { data: stages = [] } = useQuery({ queryKey: ["deal-stages"], queryFn: api.getDealStages });

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
                  <select value={deal.stageId ?? ""} onChange={(e) => update.mutate({ stageId: e.target.value })} className={input}>
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.kind !== "open" ? ` (${s.kind})` : ""}
                      </option>
                    ))}
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
                {deal.stage?.kind === "lost" && (
                  <Row label="Lost reason">
                    <input defaultValue={deal.lostReason ?? ""} onBlur={(e) => update.mutate({ lostReason: e.target.value || null })} className={input} placeholder="Why did we lose it?" />
                  </Row>
                )}
                <Row label="Next action">
                  <div className="flex flex-col gap-1">
                    <input
                      type="date"
                      defaultValue={deal.nextActionAt?.slice(0, 10) ?? ""}
                      onBlur={(e) => (e.target.value || null) !== (deal.nextActionAt?.slice(0, 10) ?? null) && update.mutate({ nextActionAt: e.target.value ? new Date(`${e.target.value}T09:00:00`).toISOString() : null })}
                      className={input}
                      title="You'll get an inbox reminder on this day"
                    />
                    <input
                      defaultValue={deal.nextActionNote ?? ""}
                      onBlur={(e) => e.target.value.trim() !== (deal.nextActionNote ?? "") && update.mutate({ nextActionNote: e.target.value.trim() || null })}
                      placeholder="e.g. Send revised proposal"
                      className={input}
                    />
                  </div>
                </Row>
                <Row label="Activity">
                  <span className="text-xs text-slate-600">
                    Last touched {fmtShortDate(deal.lastActivityAt)}
                    {deal.nextActionAt && new Date(deal.nextActionAt) <= new Date() && !deal.closedAt ? <span className="ml-1 text-red-600">· follow-up due</span> : null}
                  </span>
                </Row>
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
