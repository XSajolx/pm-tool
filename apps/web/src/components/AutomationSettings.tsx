import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type AutomationAction, type AutomationRule, type AutomationTrigger } from "../lib/api.js";
import { fmtShortDate } from "../lib/format.js";
import { useEscape } from "../lib/useEscape.js";
import { CrmField, input } from "../views/CompaniesPage.js";
import { cn } from "../lib/utils.js";

const ACTION_LABEL: Record<AutomationAction["type"], string> = { notify: "Notify", assign: "Assign the task", move: "Move the task to a status", create_task: "Create a task" };
const TO_LABEL: Record<string, string> = { admins: "owners & admins", project_lead: "the project lead", assignees: "the task's assignees", rule_owner: "the rule owner", user: "a specific person" };

function describeAction(a: AutomationAction, people: { id: string; name: string }[]) {
  const who = (id?: string | null) => people.find((p) => p.id === id)?.name ?? "someone";
  switch (a.type) {
    case "notify":
      return `Notify ${a.to === "user" ? who(a.userId) : TO_LABEL[a.to]}: “${a.message}”`;
    case "assign":
      return `Assign to ${who(a.userId)}`;
    case "move":
      return `Move to “${a.statusName}”`;
    case "create_task":
      return `Create task “${a.title}”${a.assigneeId ? ` for ${who(a.assigneeId)}` : ""}${a.dueInDays != null ? ` due in ${a.dueInDays}d` : ""}`;
  }
}

/**
 * Rows 153-155: when X then Y. Rules watch the activity log; each has an
 * owner who is alerted when a run fails, a run log, and every change a rule
 * makes is stamped with the rule on the record it touched.
 */
export function AutomationSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: rules = [], isLoading } = useQuery({ queryKey: ["automations"], queryFn: api.getAutomations, enabled: canEdit });
  const { data: triggers = [] } = useQuery({ queryKey: ["automation-triggers"], queryFn: api.getAutomationTriggers });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const people = members.map((m) => ({ id: m.id, name: m.name }));
  const [editing, setEditing] = useState<AutomationRule | null | "new">(null);
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("rule"));
  const refresh = () => qc.invalidateQueries({ queryKey: ["automations"] });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateAutomation(id, { enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteAutomation(id), onSuccess: refresh });
  if (!canEdit) return <p className="text-sm text-muted-foreground">Automations are set up by owners and admins.</p>;
  const triggerLabel = (t: AutomationTrigger) => `${triggers.find((x) => x.type === t.type)?.label ?? t.type}${t.toName ? ` “${t.toName}”` : ""}`;

  return (
    <div className="max-w-3xl" data-testid="automations">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-slate-900">Automations</h1>
          <p className="mt-1 text-sm text-muted-foreground">When something happens (a task moves, an expense is approved, an invoice goes overdue…), do something (notify, assign, move, create a task). Each rule has an owner who hears when a run fails, and every change a rule makes is marked on the record.</p>
        </div>
        <button type="button" onClick={() => setEditing("new")} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">New rule</button>
      </div>
      {isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : rules.length ? (
        <ul className="mt-4 space-y-2">
          {rules.map((r) => (
            <li key={r.id} className={cn("rounded-lg border bg-white p-4", r.enabled ? "border-border" : "border-dashed border-border opacity-70")} data-testid={`rule-${r.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2"><input type="checkbox" checked={r.enabled} onChange={(e) => toggle.mutate({ id: r.id, enabled: e.target.checked })} title={r.enabled ? "On" : "Off"} /></label>
                <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)} className="text-sm font-semibold text-slate-900 hover:underline">{r.name}</button>
                {r.project && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{r.project.name}</span>}
                <span className="text-xs text-muted-foreground">owner {r.owner.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{r.runs} run{r.runs === 1 ? "" : "s"}{r.failures ? <span className="text-red-700"> · {r.failures} failed</span> : ""}{r.lastRunAt ? ` · last ${fmtShortDate(r.lastRunAt)}` : ""}</span>
                <button type="button" onClick={() => setEditing(r)} className="text-xs text-slate-500 hover:text-slate-800">Edit</button>
                <button type="button" onClick={() => remove.mutate(r.id)} className="text-xs text-slate-400 hover:text-red-600">Delete</button>
              </div>
              <p className="mt-1.5 text-xs text-slate-700"><span className="font-medium text-indigo-700">When</span> {triggerLabel(r.trigger)} <span className="font-medium text-indigo-700">then</span> {r.actions.map((a) => describeAction(a, people)).join(" → ")}</p>
              {r.lastError && <p className="mt-1 text-xs text-red-700">Last error: {r.lastError}</p>}
              {openId === r.id && <RunLog id={r.id} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No rules yet. Try: when a task moves to “In Review”, notify the project lead and create a QA task.</p>
      )}
      {editing && <RuleDialog rule={editing === "new" ? null : editing} triggers={triggers} people={people} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />}
    </div>
  );
}

function RunLog({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ["automation", id], queryFn: () => api.getAutomation(id) });
  if (!data) return <p className="mt-2 text-xs text-muted-foreground">Loading…</p>;
  return (
    <div className="mt-3 border-t border-border pt-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Run log</p>
      {data.runLog.length ? (
        <ul className="mt-1 space-y-1 text-xs">
          {data.runLog.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", r.status === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>{r.status}</span>
              <span className="text-slate-800">{r.entityLabel ?? r.entityType}</span>
              <span className="text-muted-foreground">{r.summary.join(" · ")}{r.error ? ` — ${r.error}` : ""}</span>
              <span className="ml-auto text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">Has not run yet.</p>
      )}
    </div>
  );
}

function RuleDialog({ rule, triggers, people, onClose, onDone }: { rule: AutomationRule | null; triggers: { type: AutomationTrigger["type"]; label: string; hasName?: string }[]; people: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const { data: projects = [] } = useQuery({ queryKey: ["projects", false], queryFn: () => api.getProjects(false) });
  const [name, setName] = useState(rule?.name ?? "");
  const [ownerId, setOwnerId] = useState(rule?.owner.id ?? "");
  const [projectId, setProjectId] = useState(rule?.project?.id ?? "");
  const [trigger, setTrigger] = useState<AutomationTrigger>(rule?.trigger ?? { type: "task_status_changed", toName: "" });
  const [actions, setActions] = useState<AutomationAction[]>(rule?.actions ?? [{ type: "notify", to: "project_lead", message: "{{title}} moved to {{status}}" }]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ownerId && people.length) setOwnerId(people[0]!.id);
  }, [people, ownerId]);
  const body = { name: name.trim(), ownerId: ownerId || undefined, projectId: projectId || null, trigger: { type: trigger.type, toName: trigger.toName?.trim() || null }, actions };
  const save = useMutation({ mutationFn: () => (rule ? api.updateAutomation(rule.id, body) : api.createAutomation(body)), onSuccess: onDone, onError: (e) => setError(errorMessage(e)) });
  const t = triggers.find((x) => x.type === trigger.type);
  const setAction = (i: number, a: AutomationAction) => setActions((list) => list.map((x, j) => (j === i ? a : x)));
  const taskish = trigger.type.startsWith("task_");
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[620px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-white shadow-xl" data-testid="rule-dialog">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{rule ? "Edit rule" : "New rule"}</h2>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-3"><CrmField label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="Review handoff" /></CrmField></div>
            <CrmField label="Owner (alerted on failure)">
              <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={input}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </CrmField>
            <div className="col-span-2"><CrmField label="Only on this project (optional)">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input}><option value="">Whole workspace</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </CrmField></div>
          </div>
          <section className="rounded-md border border-border p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">When</p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <select value={trigger.type} onChange={(e) => setTrigger({ type: e.target.value as AutomationTrigger["type"], toName: "" })} className={input}>{triggers.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}</select>
              {t?.hasName && <input value={trigger.toName ?? ""} onChange={(e) => setTrigger({ ...trigger, toName: e.target.value })} className={input} placeholder={`${t.hasName} name (any if blank)`} />}
            </div>
          </section>
          <section className="rounded-md border border-border p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Then</p>
            <ul className="mt-2 space-y-2">
              {actions.map((a, i) => (
                <li key={i} className="rounded-md bg-[#fbfbfa] p-2">
                  <div className="flex items-center gap-2">
                    <select value={a.type} onChange={(e) => { const ty = e.target.value as AutomationAction["type"]; setAction(i, ty === "notify" ? { type: "notify", to: "project_lead", message: "" } : ty === "assign" ? { type: "assign", userId: people[0]?.id ?? "" } : ty === "move" ? { type: "move", statusName: "" } : { type: "create_task", title: "" }); }} className={cn(input, "w-56")}>
                      {(Object.keys(ACTION_LABEL) as AutomationAction["type"][]).map((k) => <option key={k} value={k} disabled={!taskish && (k === "assign" || k === "move")}>{ACTION_LABEL[k]}{!taskish && (k === "assign" || k === "move") ? " (tasks only)" : ""}</option>)}
                    </select>
                    <span className="flex-1" />
                    {actions.length > 1 && <button type="button" onClick={() => setActions((l) => l.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">Remove</button>}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    {a.type === "notify" && (
                      <>
                        <select value={a.to} onChange={(e) => setAction(i, { ...a, to: e.target.value as typeof a.to })} className={input}>{Object.entries(TO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                        {a.to === "user" ? <select value={a.userId ?? ""} onChange={(e) => setAction(i, { ...a, userId: e.target.value })} className={input}><option value="">Pick…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : <span />}
                        <input value={a.message} onChange={(e) => setAction(i, { ...a, message: e.target.value })} className={cn(input, "col-span-2")} placeholder="Message — {{title}}, {{project}}, {{status}}, {{actor}} are filled in" />
                      </>
                    )}
                    {a.type === "assign" && <select value={a.userId} onChange={(e) => setAction(i, { ...a, userId: e.target.value })} className={input}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
                    {a.type === "move" && <input value={a.statusName} onChange={(e) => setAction(i, { ...a, statusName: e.target.value })} className={input} placeholder="Status name, e.g. In Review" />}
                    {a.type === "create_task" && (
                      <>
                        <input value={a.title} onChange={(e) => setAction(i, { ...a, title: e.target.value })} className={cn(input, "col-span-2")} placeholder="Title — e.g. QA: {{title}}" />
                        <select value={a.assigneeId ?? ""} onChange={(e) => setAction(i, { ...a, assigneeId: e.target.value || null })} className={input}><option value="">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                        <input type="number" min="0" max="365" value={a.dueInDays ?? ""} onChange={(e) => setAction(i, { ...a, dueInDays: e.target.value === "" ? null : Number(e.target.value) })} className={input} placeholder="Due in N days" />
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setActions((l) => [...l, { type: "notify", to: "admins", message: "" }])} className="mt-2 text-xs text-indigo-700 hover:underline">＋ Add another action</button>
          </section>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          {error && <span className="text-xs text-red-700">{error}</span>}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!name.trim() || save.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{rule ? "Save" : "Create rule"}</button>
        </div>
      </form>
    </>
  );
}
