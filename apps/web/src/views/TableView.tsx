import type { Status, Task } from "../lib/api.js";
import { AvatarStack, PriorityFlag, StatusPill } from "../components/ui.js";

interface Props {
  tasks: Task[];
  statuses: Status[];
  onOpenTask: (id: string) => void;
}

/** Flat spreadsheet-style Table view. */
export function TableView({ tasks, onOpenTask }: Props) {
  return (
    <div className="p-4">
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Th className="w-12">ID</Th>
              <Th>Name</Th>
              <Th className="w-40">Status</Th>
              <Th className="w-32">Assignee</Th>
              <Th className="w-28">Due</Th>
              <Th className="w-28">Priority</Th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr
                key={t.id}
                onClick={() => onOpenTask(t.id)}
                className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40"
              >
                <Td className="text-xs text-muted-foreground">{t.reference}</Td>
                <Td className="font-medium text-slate-800">{t.title}</Td>
                <Td>
                  {t.status ? (
                    <StatusPill name={t.status.name} color={t.status.color} />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </Td>
                <Td>
                  <AvatarStack users={t.assignees.map((a) => a.user)} />
                </Td>
                <Td className="text-xs text-slate-500">
                  {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : "—"}
                </Td>
                <Td>
                  <PriorityFlag priority={t.priority} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2 font-semibold ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 ${className}`}>{children}</td>;
}
