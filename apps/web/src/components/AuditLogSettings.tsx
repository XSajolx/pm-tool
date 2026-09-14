import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, type AuditEntry } from "../lib/api.js";
import { Avatar } from "./ui.js";
import { cn } from "../lib/utils.js";

/**
 * Row 115: who changed what and when - settings, roles, deletions, sharing,
 * status changes - searchable and filterable, straight from activity_log.
 */
const TYPES: { id: string; label: string }[] = [
  { id: "", label: "Everything" },
  { id: "workspace", label: "Settings" },
  { id: "member", label: "People & roles" },
  { id: "invitation", label: "Invitations" },
  { id: "integration", label: "Connections" },
  { id: "custom_field", label: "Custom fields" },
  { id: "project", label: "Projects" },
  { id: "list", label: "Project details" },
  { id: "document", label: "Docs" },
  { id: "task", label: "Tasks" },
  { id: "milestone", label: "Milestones" },
  { id: "stage", label: "Stages" },
];

function fmt(v: unknown) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toLocaleDateString();
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function describe(e: AuditEntry) {
  const verb = e.action.replace(/_/g, " ");
  const type = TYPES.find((t) => t.id === e.entityType)?.label.toLowerCase() ?? e.entityType;
  return `${verb}${e.label ? ` · ${e.label}` : e.entityType === "workspace" ? "" : ` (${type})`}`;
}

export function AuditLogSettings() {
  const [q, setQ] = useState("");
  const [entityType, setEntityType] = useState("");
  const [actorId, setActorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data: members = [] } = useQuery({ queryKey: ["members", "all"], queryFn: () => api.getMembers() });
  const filters = { q, entityType, actorId, from: from ? `${from}T00:00:00.000Z` : "", to: to ? `${to}T23:59:59.999Z` : "" };
  const pages = useInfiniteQuery({
    queryKey: ["audit", filters],
    queryFn: ({ pageParam }) => api.getAuditLog({ ...filters, cursor: pageParam || undefined, limit: 50 }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = pages.data?.pages.flatMap((p) => p.entries) ?? [];
  const field = "rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500";

  return (
    <div className="max-w-4xl" data-testid="audit-log">
      <h1 className="text-lg font-semibold text-slate-900">Audit log</h1>
      <p className="mt-1 text-sm text-muted-foreground">Who changed what and when: settings, roles, invitations, deletions, sharing, status changes and more. Answer questions from the record instead of memory.</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actions, people, values…" className={`${field} w-64`} aria-label="Search" />
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)} className={field} aria-label="Type">
          {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select value={actorId} onChange={(e) => setActorId(e.target.value)} className={field} aria-label="Person">
          <option value="">Anyone</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} aria-label="From" />
        <span className="text-xs text-muted-foreground">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} aria-label="To" />
        {(q || entityType || actorId || from || to) && (
          <button type="button" onClick={() => { setQ(""); setEntityType(""); setActorId(""); setFrom(""); setTo(""); }} className="text-xs text-muted-foreground hover:text-slate-700">Clear</button>
        )}
      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#fbfbfa] text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-40 px-3 py-2 text-left font-medium">When</th>
              <th className="w-44 px-3 py-2 text-left font-medium">Who</th>
              <th className="px-3 py-2 text-left font-medium">What</th>
              <th className="px-3 py-2 text-left font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {pages.isLoading ? (
              <tr><td colSpan={4} className="px-3 py-4 text-muted-foreground">Loading…</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-4 text-muted-foreground">Nothing matches.</td></tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id} className="border-t border-border align-top hover:bg-muted/30">
                  <td className="px-3 py-2 text-xs tabular-nums text-slate-600" title={new Date(e.createdAt).toISOString()}>{new Date(e.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td className="px-3 py-2">
                    {e.actor ? (
                      <span className="inline-flex items-center gap-1.5 text-slate-800">
                        <Avatar user={{ id: e.actor.id, name: e.actor.name, avatarUrl: e.actor.avatarUrl, email: "", role: "member" }} size={18} />
                        {e.actor.name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">System</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-800">
                    <span className={cn("mr-1.5 rounded px-1 text-[10px] font-medium uppercase tracking-wide", e.entityType === "workspace" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600")}>{TYPES.find((t) => t.id === e.entityType)?.label ?? e.entityType}</span>
                    {e.entityType === "task" ? <Link to="/t/$taskId" params={{ taskId: e.entityId }} className="hover:underline">{describe(e)}</Link>
                      : e.entityType === "document" ? <Link to="/docs/$docId" params={{ docId: e.entityId }} className="hover:underline">{describe(e)}</Link>
                      : e.entityType === "project" || e.entityType === "list" ? <Link to="/projects/$projectId" params={{ projectId: e.entityId }} className="hover:underline">{describe(e)}</Link>
                      : describe(e)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {e.changes.length ? (
                      <ul className="space-y-0.5">
                        {e.changes.slice(0, 6).map((c, i) => (
                          <li key={i}><span className="text-muted-foreground">{c.field}:</span> {fmt(c.from)} → {fmt(c.to)}</li>
                        ))}
                        {e.changes.length > 6 && <li className="text-muted-foreground">+{e.changes.length - 6} more</li>}
                      </ul>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {pages.hasNextPage && (
          <div className="border-t border-border px-3 py-2">
            <button type="button" onClick={() => pages.fetchNextPage()} disabled={pages.isFetchingNextPage} className="text-xs text-indigo-700 hover:underline disabled:opacity-50">
              {pages.isFetchingNextPage ? "Loading…" : "Load older"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
