import { useMemo, useState } from "react";
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
import type { Status, Task } from "../lib/api.js";
import { AvatarStack, PRIORITY } from "../components/ui.js";
import { cn } from "../lib/utils.js";

interface Props {
  tasks: Task[];
  statuses: Status[];
  onOpenTask: (id: string) => void;
  onMoveTask?: (taskId: string, statusId: string) => void;
}

const NO_STATUS = "none";

export function BoardView({ tasks, statuses, onOpenTask, onMoveTask }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const columns = useMemo(() => {
    const cols = statuses.map((s) => ({ ...s, tasks: [] as Task[] }));
    const none = { id: NO_STATUS, name: "No status", color: "#cbd5e1", tasks: [] as Task[] };
    for (const t of tasks) {
      const col = cols.find((c) => c.id === t.statusId);
      (col ?? none).tasks.push(t);
    }
    return none.tasks.length ? [none, ...cols] : cols;
  }, [tasks, statuses]);

  const activeTask = tasks.find((t) => t.id === activeId) ?? null;

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }
  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const taskId = String(e.active.id);
    const target = e.over ? String(e.over.id) : null;
    if (!target || target === NO_STATUS) return;
    const task = tasks.find((t) => t.id === taskId);
    if (task && task.statusId !== target) onMoveTask?.(taskId, target);
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex h-full gap-3 overflow-x-auto p-4">
        {columns.map((col) => (
          <Column key={col.id} id={col.id} name={col.name} color={col.color} count={col.tasks.length}>
            {col.tasks.map((task) => (
              <Card key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
            ))}
          </Column>
        ))}
      </div>
      <DragOverlay>{activeTask ? <CardBody task={activeTask} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({
  id,
  name,
  color,
  count,
  children,
}: {
  id: string;
  name: string;
  color: string;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="text-sm font-semibold text-slate-700">{name}</span>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-col gap-2 rounded-lg p-1 transition",
          isOver && "bg-indigo-50 ring-2 ring-inset ring-indigo-200",
        )}
      >
        {children}
        {count === 0 && (
          <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            Drop tasks here
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onOpen}
      className={cn("cursor-grab active:cursor-grabbing", isDragging && "opacity-30")}
    >
      <CardBody task={task} />
    </div>
  );
}

function CardBody({ task, dragging }: { task: Task; dragging?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-white p-3 shadow-sm",
        dragging ? "rotate-2 shadow-lg" : "hover:border-indigo-200 hover:shadow",
      )}
    >
      <div className="flex items-start gap-2">
        {task.priority && (
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY[task.priority].color}`} />
        )}
        <p className="text-sm leading-snug text-slate-800">{task.title}</p>
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{task.reference ?? ""}</span>
        <AvatarStack users={task.assignees.map((a) => a.user)} />
      </div>
    </div>
  );
}
