import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type LeaveRequest } from "../lib/api.js";
import { cn } from "../lib/utils.js";

const KIND: Record<LeaveRequest["kind"], string> = { vacation: "Vacation", sick: "Sick", personal: "Personal", other: "Other" };
const STATUS: Record<LeaveRequest["status"], string> = {
  pending: "bg-amber-50 text-amber-800",
  approved: "bg-green-50 text-green-700",
  rejected: "bg-red-50 text-red-700",
  cancelled: "bg-slate-100 text-slate-500",
};

/**
 * Row 98: request time off (type, dates, note); see your requests and their
 * status; project managers see everyone's pending ones and decide inline.
 * Approved leave shows up as PTO hours on the timesheet automatically.
 */
export function TimeOffPanel({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<LeaveRequest["kind"]>("vacation");
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const { data: mine = [] } = useQuery({ queryKey: ["leave", "mine"], queryFn: () => api.getLeave() });
  const { data: all = [] } = useQuery({ queryKey: ["leave", "all"], queryFn: () => api.getLeave({ all: true }), enabled: isAdmin });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["leave"] });
    qc.invalidateQueries({ queryKey: ["timesheet"] });
    qc.invalidateQueries({ queryKey: ["timesheet-board"] });
    qc.invalidateQueries({ queryKey: ["resourcing"] });
  };
  const request = useMutation({
    mutationFn: () => api.requestLeave({ kind, startDate: `${start}T00:00:00.000Z`, endDate: `${end}T00:00:00.000Z`, note: note.trim() || undefined }),
    onSuccess: () => {
      setOpen(false);
      setNote("");
      refresh();
    },
  });
  const cancel = useMutation({ mutationFn: api.cancelLeave, onSuccess: refresh });
  const decide = useMutation({ mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.decideLeave(id, { approve }), onSuccess: refresh });
  const pendingOthers = all.filter((l) => l.status === "pending" && !mine.some((m) => m.id === l.id));
  const input = "rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700";
  const fmt = (d: string) => new Date(d).toLocaleDateString();

  return (
    <section className="mt-4 rounded-lg border border-border bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Time off</h2>
        {pendingOthers.length > 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{pendingOthers.length} awaiting you</span>}
        <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-muted">
          {open ? "Cancel" : "🏖 Request time off"}
        </button>
      </div>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate();
          }}
          className="flex flex-wrap items-end gap-2 border-b border-border bg-[#fbfbfa] px-4 py-3"
        >
          <label className="text-[11px] text-slate-600">
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as LeaveRequest["kind"])} className={cn(input, "mt-0.5 block")}>
              {(Object.keys(KIND) as LeaveRequest["kind"][]).map((k) => (
                <option key={k} value={k}>
                  {KIND[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-slate-600">
            From
            <input type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} className={cn(input, "mt-0.5 block")} />
          </label>
          <label className="text-[11px] text-slate-600">
            To
            <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className={cn(input, "mt-0.5 block")} />
          </label>
          <label className="min-w-[200px] flex-1 text-[11px] text-slate-600">
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" className={cn(input, "mt-0.5 block w-full")} />
          </label>
          <button type="submit" disabled={request.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            Send request
          </button>
          {request.isError && <span className="basis-full text-xs text-red-600">{(request.error as Error).message}</span>}
        </form>
      )}
      <ul className="divide-y divide-border">
        {isAdmin &&
          pendingOthers.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
              <span className="font-medium text-slate-800">{l.user?.name}</span>
              <span className="text-slate-600">
                {KIND[l.kind]} · {fmt(l.startDate)} → {fmt(l.endDate)} · {l.days} day{l.days === 1 ? "" : "s"}
              </span>
              {l.note && <span className="text-xs text-muted-foreground">“{l.note}”</span>}
              <span className="ml-auto flex gap-2">
                <button type="button" onClick={() => decide.mutate({ id: l.id, approve: true })} className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700">
                  ✓ Approve
                </button>
                <button type="button" onClick={() => decide.mutate({ id: l.id, approve: false })} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-red-50 hover:text-red-700">
                  ✕ Decline
                </button>
              </span>
            </li>
          ))}
        {mine.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", STATUS[l.status])}>{l.status}</span>
            <span className="text-slate-700">
              {KIND[l.kind]} · {fmt(l.startDate)} → {fmt(l.endDate)} · {l.days} day{l.days === 1 ? "" : "s"} · {l.hoursPerDay}h/day
            </span>
            {l.note && <span className="text-xs text-muted-foreground">“{l.note}”</span>}
            {l.decisionNote && <span className="text-xs text-muted-foreground">— {l.decisionNote}</span>}
            {(l.status === "pending" || l.status === "approved") && (
              <button type="button" onClick={() => cancel.mutate(l.id)} className="ml-auto text-xs text-slate-500 hover:text-red-600 hover:underline">
                {l.status === "approved" ? "Cancel leave" : "Withdraw"}
              </button>
            )}
          </li>
        ))}
        {!mine.length && !pendingOthers.length && <li className="px-4 py-3 text-xs text-muted-foreground">No time off requested yet.</li>}
      </ul>
    </section>
  );
}
