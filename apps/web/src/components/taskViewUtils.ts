import type { Member, Status, Task } from "../lib/api.js";

/** How the List view buckets tasks. */
export type GroupBy = "status" | "assignee" | "priority" | "stage" | "dueDate" | "none";
/** Sort keys shared by List and Table. `manual` = the list's own position. */
export type SortKey = "manual" | "dueDate" | "priority" | "title" | "status";
export type SortDir = "asc" | "desc";

export const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "assignee", label: "Assignee" },
  { value: "priority", label: "Priority" },
  { value: "stage", label: "Stage" },
  { value: "dueDate", label: "Due date" },
  { value: "none", label: "No grouping" },
];

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "dueDate", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Name" },
  { value: "status", label: "Status" },
];

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function sortTasks(tasks: Task[], key: SortKey, dir: SortDir, statuses: Status[]): Task[] {
  if (key === "manual") return tasks;
  const statusPos = new Map(statuses.map((s, i) => [s.id, i]));
  const cmp = (a: Task, b: Task): number => {
    switch (key) {
      case "dueDate": {
        // Undated tasks sink to the bottom regardless of direction.
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate) * (dir === "asc" ? 1 : -1);
      }
      case "priority": {
        const ra = a.priority ? PRIORITY_RANK[a.priority]! : 9;
        const rb = b.priority ? PRIORITY_RANK[b.priority]! : 9;
        return (ra - rb) * (dir === "asc" ? 1 : -1);
      }
      case "title":
        return a.title.localeCompare(b.title) * (dir === "asc" ? 1 : -1);
      case "status": {
        const ra = a.statusId ? (statusPos.get(a.statusId) ?? 99) : 99;
        const rb = b.statusId ? (statusPos.get(b.statusId) ?? 99) : 99;
        return (ra - rb) * (dir === "asc" ? 1 : -1);
      }
      default:
        return 0;
    }
  };
  return [...tasks].sort(cmp);
}

export interface TaskGroup {
  key: string;
  label: string;
  color: string;
  tasks: Task[];
}

/** Buckets tasks for the List view. Empty status/priority buckets are kept so drops make sense. */
export function groupTasks(tasks: Task[], by: GroupBy, statuses: Status[], members: Member[]): TaskGroup[] {
  const groups: TaskGroup[] = [];
  const push = (key: string, label: string, color: string) => {
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, label, color, tasks: [] };
      groups.push(g);
    }
    return g;
  };
  switch (by) {
    case "none":
      return [{ key: "all", label: "All tasks", color: "#94a3b8", tasks }];
    case "status": {
      for (const s of statuses) push(s.id, s.name, s.color);
      const none: Task[] = [];
      for (const t of tasks) {
        const g = groups.find((x) => x.key === t.statusId);
        if (g) g.tasks.push(t);
        else none.push(t);
      }
      return none.length ? [{ key: "none", label: "No status", color: "#cbd5e1", tasks: none }, ...groups] : groups;
    }
    case "priority": {
      const order: { key: string; label: string; color: string }[] = [
        { key: "urgent", label: "Urgent", color: "#ef4444" },
        { key: "high", label: "High", color: "#f97316" },
        { key: "normal", label: "Normal", color: "#3b82f6" },
        { key: "low", label: "Low", color: "#94a3b8" },
        { key: "none", label: "No priority", color: "#cbd5e1" },
      ];
      for (const o of order) push(o.key, o.label, o.color);
      for (const t of tasks) groups.find((g) => g.key === (t.priority ?? "none"))!.tasks.push(t);
      return groups.filter((g) => g.tasks.length || g.key !== "none");
    }
    case "assignee": {
      for (const t of tasks) {
        if (!t.assignees.length) push("unassigned", "Unassigned", "#cbd5e1").tasks.push(t);
        for (const a of t.assignees) push(a.user.id, a.user.name, "#6366f1").tasks.push(t);
      }
      // Members in roster order, unassigned last.
      const rank = new Map(members.map((m, i) => [m.id, i]));
      return groups.sort((a, b) => {
        if (a.key === "unassigned") return 1;
        if (b.key === "unassigned") return -1;
        return (rank.get(a.key) ?? 99) - (rank.get(b.key) ?? 99);
      });
    }
    case "stage": {
      for (const t of tasks) {
        const g = t.stage ? push(t.stage.id, t.stage.name, "#8b5cf6") : push("none", "No stage", "#cbd5e1");
        g.tasks.push(t);
      }
      return groups.sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : 0));
    }
    case "dueDate": {
      const today = startOfDay(new Date());
      const week = new Date(today);
      week.setDate(week.getDate() + 7);
      const bucket = (t: Task) => {
        if (!t.dueDate) return { key: "none", label: "No due date", color: "#cbd5e1" };
        const d = startOfDay(new Date(t.dueDate));
        if (d < today) return { key: "overdue", label: "Overdue", color: "#ef4444" };
        if (d.getTime() === today.getTime()) return { key: "today", label: "Today", color: "#f59e0b" };
        if (d < week) return { key: "week", label: "This week", color: "#3b82f6" };
        return { key: "later", label: "Later", color: "#94a3b8" };
      };
      const order = ["overdue", "today", "week", "later", "none"];
      for (const t of tasks) {
        const b = bucket(t);
        push(b.key, b.label, b.color).tasks.push(t);
      }
      return groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
  }
}

export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Local calendar day → ISO at UTC midnight, matching how date inputs store due dates. */
export function dayToIso(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}T00:00:00.000Z`;
}

/** "YYYY-MM-DD" key for an ISO date, using the UTC date part (how due dates are stored). */
export function isoDayKey(iso: string) {
  return iso.slice(0, 10);
}
