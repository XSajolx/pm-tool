import { useMemo, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MyTask } from "../lib/api.js";
import { fmtShortDate } from "../lib/format.js";
import { StatusPill } from "./ui.js";

type CrmLink = { companyId?: string; contactId?: string; dealId?: string };
const LAST_LIST_KEY = "pm:crmFollowUpList";

/**
 * Row 38: the follow-ups attached to a client, contact or deal, with a one-line
 * "add follow-up" form. Lives on the company page ("Tasks" tab) and inside the
 * deal drawer. Open tasks first, done ones greyed out underneath.
 */
export function CrmTasks({ link, compact = false }: { link: CrmLink; compact?: boolean }) {
  const qc = useQueryClient();
  const { data: tasks = [], isLoading } = useQuery({ queryKey: ["crm-tasks", link], queryFn: () => api.getCrmTasks(link) });
  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces });
  const lists = useMemo(
    () =>
      spaces.flatMap((sp) => [
        ...sp.lists.map((l) => ({ id: l.id, label: `${sp.name} › ${l.name}` })),
        ...sp.folders.flatMap((f) => f.lists.map((l) => ({ id: l.id, label: `${sp.name} › ${f.name} › ${l.name}` }))),
      ]),
    [spaces],
  );
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [listId, setListId] = useState(() => {
    try {
      return localStorage.getItem(LAST_LIST_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const target = lists.some((l) => l.id === listId) ? listId : (lists[0]?.id ?? "");

  const add = useMutation({
    mutationFn: () =>
      api.createTask({
        listId: target,
        title: title.trim(),
        dueDate: due ? new Date(due + "T00:00:00Z").toISOString() : null,
        ...link,
      }),
    onSuccess: () => {
      try {
        localStorage.setItem(LAST_LIST_KEY, target);
      } catch {
        /* ignore */
      }
      setTitle("");
      setDue("");
      qc.invalidateQueries({ queryKey: ["crm-tasks"] });
      qc.invalidateQueries({ queryKey: ["tasks", target] });
    },
  });
  const toggle = useMutation({
    mutationFn: (t: MyTask) => (t.status?.category === "done" ? api.reopenTask(t.id) : api.completeTask(t.id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm-tasks"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim() && target && !add.isPending) add.mutate();
  }

  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a follow-up, e.g. Send revised proposal"
          className="min-w-[200px] flex-1 rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="rounded-md border border-border bg-white px-2 py-1.5 text-xs text-slate-700" aria-label="Due date" />
        <select value={target} onChange={(e) => setListId(e.target.value)} className="max-w-[200px] rounded-md border border-border bg-white px-2 py-1.5 text-xs text-slate-700" aria-label="List">
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!title.trim() || !target || add.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
          {add.isPending ? "Adding…" : "Add"}
        </button>
      </form>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className={`rounded-lg border border-dashed border-border text-center text-sm text-muted-foreground ${compact ? "py-4" : "py-8"}`}>
          No tasks linked yet. Add a follow-up above, or link an existing task from its “Client” field.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-white">
          {tasks.map((t) => {
            const done = t.status?.category === "done";
            const overdue = !done && t.dueDate && new Date(t.dueDate) < new Date(new Date().toDateString());
            return (
              <li key={t.id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                <input type="checkbox" checked={done} onChange={() => toggle.mutate(t)} className="h-3.5 w-3.5 cursor-pointer accent-indigo-600" aria-label={done ? "Reopen" : "Complete"} />
                <div className="min-w-0 flex-1">
                  <Link to="/t/$taskId" params={{ taskId: t.id }} className={`block truncate text-sm ${done ? "text-slate-400 line-through" : "text-slate-800 hover:text-indigo-700"}`}>
                    {t.title}
                  </Link>
                  {!compact && (
                    <p className="truncate text-[11px] text-muted-foreground">
                      {t.list ? `${t.list.spaceName ?? ""} › ${t.list.name}` : ""}
                      {t.deal && !link.dealId ? ` · 💼 ${t.deal.title}` : ""}
                      {t.contact && !link.contactId ? ` · 👤 ${[t.contact.firstName, t.contact.lastName].filter(Boolean).join(" ")}` : ""}
                    </p>
                  )}
                </div>
                {t.status && <StatusPill name={t.status.name} color={t.status.color} />}
                <span className="w-20 text-right text-xs text-slate-500">{t.assignees?.[0]?.user.name.split(" ")[0] ?? ""}</span>
                <span className={`w-14 text-right text-xs ${overdue ? "font-medium text-red-600" : "text-muted-foreground"}`}>{t.dueDate ? fmtShortDate(t.dueDate) : ""}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
