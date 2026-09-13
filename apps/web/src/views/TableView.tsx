import { useMemo } from "react";
import type { Member, Status, Task } from "../lib/api.js";
import { AssigneeCell, DueCell, PriorityCell, StatusCell, type UpdateTask } from "../components/InlineEditors.js";
import { sortTasks, type SortDir, type SortKey } from "../components/taskViewUtils.js";

interface Props {
  tasks: Task[];
  statuses: Status[];
  members: Member[];
  sort: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onOpenTask: (id: string) => void;
  onUpdate: UpdateTask;
}

/** Flat spreadsheet-style Table view: click a header to sort, edit cells inline. */
export function TableView({ tasks, statuses, members, sort, sortDir, onSort, onOpenTask, onUpdate }: Props) {
  const rows = useMemo(() => sortTasks(tasks, sort, sortDir, statuses), [tasks, sort, sortDir, statuses]);
  const arrow = (key: SortKey) => (sort === key ? (sortDir === "asc" ? " ↑" : " ↓") : "");
  return (
    <div className="p-4">
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Th className="w-12">ID</Th>
              <Th onClick={() => onSort("title")}>Name{arrow("title")}</Th>
              <Th className="w-40" onClick={() => onSort("status")}>
                Status{arrow("status")}
              </Th>
              <Th className="w-32">Assignee</Th>
              <Th className="w-28" onClick={() => onSort("dueDate")}>
                Due{arrow("dueDate")}
              </Th>
              <Th className="w-28" onClick={() => onSort("priority")}>
                Priority{arrow("priority")}
              </Th>
              <Th className="w-40">Tags</Th>
              <Th className="w-28">Estimate</Th>
              <Th className="w-32">Stage</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} onClick={() => onOpenTask(t.id)} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40">
                <Td className="text-xs text-muted-foreground">{t.reference}</Td>
                <Td className={`font-medium ${t.status?.category === "done" ? "text-slate-400 line-through" : "text-slate-800"}`}>{t.title}</Td>
                <Td>
                  <StatusCell task={t} statuses={statuses} onUpdate={onUpdate} />
                </Td>
                <Td>
                  <AssigneeCell task={t} members={members} onUpdate={onUpdate} />
                </Td>
                <Td>
                  <DueCell task={t} onUpdate={onUpdate} />
                </Td>
                <Td>
                  <PriorityCell task={t} onUpdate={onUpdate} />
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {(t.tags ?? []).map((tag) => (
                      <span key={tag.id} className="rounded-full px-1.5 text-[10px] font-medium" style={{ background: `${tag.color}22`, color: tag.color }}>
                        {tag.name}
                      </span>
                    ))}
                  </span>
                </Td>
                <Td className="text-xs text-slate-500">{t.timeEstimateMinutes ? formatEstimate(t.timeEstimateMinutes) : "—"}</Td>
                <Td className="text-xs text-slate-500">{t.stage?.name ?? "—"}</Td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No tasks
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatEstimate(m: number) {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h && rest ? `${h}h ${rest}m` : h ? `${h}h` : `${rest}m`;
}

function Th({ children, className = "", onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <th className={`px-4 py-2 font-semibold ${onClick ? "cursor-pointer select-none hover:text-slate-700" : ""} ${className}`} onClick={onClick}>
      {children}
    </th>
  );
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 ${className}`}>{children}</td>;
}
