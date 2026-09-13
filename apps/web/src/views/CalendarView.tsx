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
import type { Task } from "../lib/api.js";
import { PRIORITY } from "../components/ui.js";
import { cn } from "../lib/utils.js";
import { dayToIso, isoDayKey } from "../components/taskViewUtils.js";

interface Props {
  tasks: Task[];
  onOpenTask: (id: string) => void;
  onReschedule: (taskId: string, dueDateIso: string | null) => void;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const UNSCHEDULED = "unscheduled";

/**
 * Month calendar keyed by due date. Drag a task chip onto another day to
 * reschedule it; drop it on the "Unscheduled" tray to clear the due date.
 */
export function CalendarView({ tasks, onOpenTask, onReschedule }: Props) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const days = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.dueDate) continue;
      const key = isoDayKey(t.dueDate);
      m.set(key, [...(m.get(key) ?? []), t]);
    }
    return m;
  }, [tasks]);
  const unscheduled = useMemo(() => tasks.filter((t) => !t.dueDate && t.status?.category !== "done"), [tasks]);
  const activeTask = tasks.find((t) => t.id === activeId) ?? null;
  const todayKey = localDayKey(new Date());

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const taskId = String(e.active.id);
    const target = e.over ? String(e.over.id) : null;
    if (!target) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (target === UNSCHEDULED) {
      if (task.dueDate) onReschedule(taskId, null);
      return;
    }
    if (task.dueDate && isoDayKey(task.dueDate) === target) return;
    onReschedule(taskId, `${target}T00:00:00.000Z`);
  };

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))} onDragEnd={onDragEnd}>
      <div className="flex h-full gap-4 p-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-3 flex items-center gap-2">
            <button type="button" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} className="rounded-md border border-border bg-white px-2 py-1 text-sm hover:bg-muted">
              ‹
            </button>
            <button type="button" onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))} className="rounded-md border border-border bg-white px-2.5 py-1 text-xs hover:bg-muted">
              Today
            </button>
            <button type="button" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} className="rounded-md border border-border bg-white px-2 py-1 text-sm hover:bg-muted">
              ›
            </button>
            <h2 className="ml-2 text-sm font-semibold text-slate-800">{monthLabel}</h2>
            <span className="ml-auto text-xs text-muted-foreground">Drag a task to another day to reschedule it</span>
          </div>

          <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-border bg-white">
            {WEEKDAYS.map((d) => (
              <div key={d} className="border-b border-border bg-muted/50 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {d}
              </div>
            ))}
            {days.map((day) => (
              <DayCell
                key={day.key}
                dayKey={day.key}
                date={day.date}
                inMonth={day.inMonth}
                isToday={day.key === todayKey}
                tasks={byDay.get(day.key) ?? []}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        </div>

        <UnscheduledTray tasks={unscheduled} onOpenTask={onOpenTask} />
      </div>
      <DragOverlay>{activeTask ? <Chip task={activeTask} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}

function DayCell({
  dayKey,
  date,
  inMonth,
  isToday,
  tasks,
  onOpenTask,
}: {
  dayKey: string;
  date: Date;
  inMonth: boolean;
  isToday: boolean;
  tasks: Task[];
  onOpenTask: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dayKey });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-h-[96px] border-b border-r border-border p-1.5 transition",
        !inMonth && "bg-muted/30",
        isOver && "bg-indigo-50 ring-2 ring-inset ring-indigo-200",
      )}
    >
      <div className="mb-1 flex items-center justify-between">
        <span
          className={cn(
            "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px]",
            isToday ? "bg-indigo-600 font-semibold text-white" : inMonth ? "text-slate-700" : "text-slate-400",
          )}
        >
          {date.getDate()}
        </span>
        {tasks.length > 3 && <span className="text-[10px] text-muted-foreground">{tasks.length}</span>}
      </div>
      <div className="flex flex-col gap-1">
        {tasks.map((t) => (
          <DraggableChip key={t.id} task={t} onOpen={() => onOpenTask(t.id)} />
        ))}
      </div>
    </div>
  );
}

function UnscheduledTray({ tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: UNSCHEDULED });
  return (
    <div
      ref={setNodeRef}
      className={cn("flex w-56 shrink-0 flex-col rounded-lg border border-border bg-white p-3 transition", isOver && "bg-indigo-50 ring-2 ring-inset ring-indigo-200")}
    >
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Unscheduled <span className="font-normal normal-case">({tasks.length})</span>
      </p>
      <div className="flex flex-col gap-1 overflow-y-auto">
        {tasks.map((t) => (
          <DraggableChip key={t.id} task={t} onOpen={() => onOpenTask(t.id)} />
        ))}
        {!tasks.length && <p className="text-xs text-muted-foreground">Drop a task here to clear its date.</p>}
      </div>
    </div>
  );
}

function DraggableChip({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: task.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} onClick={onOpen} className={cn("cursor-grab active:cursor-grabbing", isDragging && "opacity-30")}>
      <Chip task={task} />
    </div>
  );
}

function Chip({ task, dragging }: { task: Task; dragging?: boolean }) {
  const done = task.status?.category === "done";
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-border bg-white px-1.5 py-1 text-[11px] leading-tight text-slate-800 shadow-sm",
        dragging && "rotate-1 shadow-lg",
        done && "text-slate-400 line-through",
      )}
      title={task.title}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: task.status?.color ?? "#cbd5e1" }} />
      <span className="truncate">{task.title}</span>
      {task.priority && <span className={cn("ml-auto h-1.5 w-1.5 shrink-0 rounded-full", PRIORITY[task.priority].color)} />}
    </div>
  );
}

/** Six weeks of days starting on the Monday on or before the 1st. */
function buildMonthGrid(first: Date) {
  const start = new Date(first);
  const offset = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - offset);
  const out: { key: string; date: Date; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push({ key: localDayKey(d), date: d, inMonth: d.getMonth() === first.getMonth() });
  }
  return out;
}

function localDayKey(d: Date) {
  return dayToIso(d).slice(0, 10);
}
