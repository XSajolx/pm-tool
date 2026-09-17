import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AppNotification, type ApprovalMeta, type PendingTimesheet } from "../lib/api.js";
import { Avatar } from "./ui.js";
import { fmtDuration } from "../lib/format.js";
import { cn } from "../lib/utils.js";

/**
 * Row 104: everything waiting on my decision - submitted timesheets first,
 * then doc reviews, milestone sign-offs and time-off requests from the inbox -
 * each with one-click Approve / Reject so nothing piles up.
 */
const KIND_LABEL: Record<ApprovalMeta["kind"], string> = { timesheet: "Timesheet", doc_review: "Doc review", milestone: "Milestone sign-off", leave: "Time off", expense: "Expense" };

function weekLabel(iso: string) {
  const d = new Date(iso);
  const end = new Date(d.getTime() + 6 * 86_400_000);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

function DecideButtons({ onDecide, busy }: { onDecide: (approve: boolean, note?: string) => void; busy: boolean }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  if (rejecting) {
    return (
      <form
        onSubmit={(e) => { e.preventDefault(); onDecide(false, note.trim() || undefined); setRejecting(false); setNote(""); }}
        className="flex items-center gap-1"
      >
        <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why? (optional)" className="w-40 rounded-md border border-border bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400" />
        <button type="submit" disabled={busy} className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Reject</button>
        <button type="button" onClick={() => setRejecting(false)} className="text-xs text-muted-foreground hover:text-slate-700">Cancel</button>
      </form>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <button type="button" disabled={busy} onClick={() => onDecide(true)} className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">✓ Approve</button>
      <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="rounded-md border border-border bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-red-300 hover:text-red-700 disabled:opacity-50">✕ Reject</button>
    </div>
  );
}

export function PendingApprovalsWidget() {
  const qc = useQueryClient();
  const { data: sheets = [], isLoading: l1 } = useQuery({ queryKey: ["pending-timesheets"], queryFn: api.getPendingTimesheets, refetchInterval: 60_000 });
  const { data: inbox = [], isLoading: l2 } = useQuery({ queryKey: ["notifications", "approvals"], queryFn: () => api.getNotifications("approvals"), refetchInterval: 60_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pending-timesheets"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["unread-count"] });
    qc.invalidateQueries({ queryKey: ["timesheet"] });
    qc.invalidateQueries({ queryKey: ["milestones"] });
    qc.invalidateQueries({ queryKey: ["document"] });
    qc.invalidateQueries({ queryKey: ["leave"] });
  };
  const decideSheet = useMutation({ mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => api.decideTimesheet(id, { approve, note }), onSuccess: refresh });
  const decideOther = useMutation({ mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => api.decideApproval(id, { approve, note }), onSuccess: refresh });

  // Inbox approvals still pending, minus timesheets (those come from the richer list above).
  const sheetIds = new Set(sheets.map((s) => s.id));
  const others = inbox.filter((n) => {
    const a = n.data?.approval as ApprovalMeta | undefined;
    return a && a.status === "pending" && !(a.kind === "timesheet" && sheetIds.has(n.entityId));
  });
  const total = sheets.length + others.length;
  const loading = l1 || l2;

  return (
    <section className="rounded-lg border border-border bg-white" data-testid="pending-approvals">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending approvals</h2>
        {total > 0 && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">{total}</span>}
        <Link to="/inbox" className="ml-auto text-xs text-indigo-700 hover:underline">Inbox →</Link>
      </div>
      <div className="p-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting on you. 🎉</p>
        ) : (
          <ul className="divide-y divide-border">
            {sheets.map((s: PendingTimesheet) => {
              const hours = Math.round((s.totalSeconds / 3600) * 10) / 10;
              const short = s.expectedHours > 0 && hours < s.expectedHours * 0.9;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <Avatar user={{ id: s.user.id, name: s.user.name, avatarUrl: s.user.avatarUrl, email: "", role: "member" }} size={20} />
                  <div className="min-w-0 flex-1">
                    <p className="text-slate-800">
                      <span className="font-medium">{s.user.name}</span> · timesheet {weekLabel(s.weekStart)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <span className={cn("tabular-nums", short && "text-amber-700")}>{fmtDuration(s.totalSeconds)} of {s.expectedHours}h</span>
                      {short ? " · under expected" : ""}
                      {s.note ? ` · “${s.note}”` : ""}
                      {" · "}submitted {new Date(s.submittedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Link to="/timesheets" className="text-xs text-indigo-700 hover:underline">Review</Link>
                  <DecideButtons busy={decideSheet.isPending} onDecide={(approve, note) => decideSheet.mutate({ id: s.id, approve, note })} />
                </li>
              );
            })}
            {others.map((n: AppNotification) => {
              const a = n.data!.approval as ApprovalMeta;
              return (
                <li key={n.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  {n.triggeredBy ? <Avatar user={{ id: n.triggeredBy.id, name: n.triggeredBy.name, avatarUrl: n.triggeredBy.avatarUrl, email: "", role: "member" }} size={20} /> : <span className="h-5 w-5 rounded-full bg-slate-200" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-slate-800">
                      <span className="rounded bg-slate-100 px-1 text-[10px] font-medium uppercase tracking-wide text-slate-600">{KIND_LABEL[a.kind] ?? a.kind}</span>{" "}
                      {n.title}
                    </p>
                    {n.body && <p className="truncate text-xs text-muted-foreground">{n.body}</p>}
                  </div>
                  <DecideButtons busy={decideOther.isPending} onDecide={(approve, note) => decideOther.mutate({ id: n.id, approve, note })} />
                </li>
              );
            })}
          </ul>
        )}
        {(decideSheet.isError || decideOther.isError) && (
          <p className="mt-2 text-xs text-red-600">{String((decideSheet.error ?? decideOther.error as Error)?.message ?? "Could not save the decision")}</p>
        )}
      </div>
    </section>
  );
}
