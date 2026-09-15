import { useEffect, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, type Task } from "../../lib/api.js";

/**
 * Row 14: live task and list embeds. The doc stores only the id; the card reads
 * the task (or the list's tasks) every time the page opens, so status, owner
 * and due date are never stale. Status can be changed right from the card.
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    embedBlocks: {
      insertTaskEmbed: (taskId?: string | null) => ReturnType;
      insertListEmbed: (listId?: string | null) => ReturnType;
    };
  }
}

const fmtDue = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null);

function TaskRow({ task, editable, onStatus }: { task: Task; editable: boolean; onStatus?: (statusId: string) => void }) {
  const done = task.status?.category === "done";
  const overdue = !done && task.dueDate && new Date(task.dueDate) < new Date();
  return (
    <div className="doc-task-row">
      <span className="doc-task-dot" style={{ background: task.status?.color ?? "#94a3b8" }} />
      <Link to="/t/$taskId" params={{ taskId: task.id }} className={`doc-task-title${done ? " done" : ""}`}>
        {task.reference ? <span className="doc-task-ref">{task.reference}</span> : null}
        {task.title}
      </Link>
      {editable && onStatus ? (
        <StatusSelect task={task} onChange={onStatus} />
      ) : (
        task.status && <span className="doc-task-status">{task.status.name}</span>
      )}
      {task.assignees.length > 0 && <span className="doc-task-people">{task.assignees.map((a) => a.user.name.split(" ")[0]).join(", ")}</span>}
      {task.dueDate && <span className={`doc-task-due${overdue ? " overdue" : ""}`}>{fmtDue(task.dueDate)}</span>}
    </div>
  );
}

/** Status picker scoped to the task's space (statuses are per space). */
function StatusSelect({ task, onChange }: { task: Task; onChange: (statusId: string) => void }) {
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces });
  useEffect(() => {
    // Find which space owns this task's list.
    const listId = (task as unknown as { listId?: string }).listId;
    for (const s of spaces) {
      if (s.lists.some((l) => l.id === listId) || s.folders.some((f) => f.lists.some((l) => l.id === listId))) setSpaceId(s.id);
    }
  }, [spaces, task]);
  const { data: statuses = [] } = useQuery({ queryKey: ["statuses", spaceId], queryFn: () => api.getStatuses(spaceId!), enabled: Boolean(spaceId) });
  if (!statuses.length) return task.status ? <span className="doc-task-status">{task.status.name}</span> : null;
  return (
    <select value={task.status?.id ?? ""} onChange={(e) => onChange(e.target.value)} onMouseDown={(e) => e.stopPropagation()} className="doc-task-select" style={{ color: task.status?.color ?? undefined }}>
      {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

function TaskEmbedView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const taskId = node.attrs.taskId as string | null;
  const qc = useQueryClient();
  const editable = editor.isEditable;
  const [q, setQ] = useState("");
  const { data: task, isError } = useQuery({ queryKey: ["task", taskId], queryFn: () => api.getTask(taskId!), enabled: Boolean(taskId) });
  const { data: hits } = useQuery({ queryKey: ["search", q], queryFn: () => api.search(q), enabled: !taskId && q.trim().length >= 2 });
  const setStatus = useMutation({ mutationFn: (statusId: string) => api.updateTask(taskId!, { statusId }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["task", taskId] }); qc.invalidateQueries({ queryKey: ["tasks"] }); } });
  const taskHits = hits?.groups.find((g) => g.type === "task")?.items ?? [];
  return (
    <NodeViewWrapper className={`doc-embed doc-embed-task${selected ? " ProseMirror-selectednode" : ""}`} data-type="taskEmbed" contentEditable={false}>
      {!taskId ? (
        editable ? (
          <div className="doc-embed-pick">
            <span>☐ Embed a task</span>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks…" onMouseDown={(e) => e.stopPropagation()} />
            {taskHits.length > 0 && (
              <ul className="doc-embed-results">
                {taskHits.slice(0, 8).map((h) => (
                  <li key={h.id}><button type="button" onMouseDown={(e) => { e.preventDefault(); updateAttributes({ taskId: h.id }); }}>{h.title}<span>{h.subtitle}</span></button></li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <span className="doc-embed-empty">No task chosen.</span>
        )
      ) : isError ? (
        <span className="doc-embed-empty">This task is no longer available.</span>
      ) : !task ? (
        <span className="doc-embed-empty">Loading task…</span>
      ) : (
        <TaskRow task={task} editable={editable} onStatus={(id) => setStatus.mutate(id)} />
      )}
    </NodeViewWrapper>
  );
}

function ListEmbedView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const listId = node.attrs.listId as string | null;
  const qc = useQueryClient();
  const editable = editor.isEditable;
  const [showDone, setShowDone] = useState(false);
  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces });
  const { data: tasks = [], isError } = useQuery({ queryKey: ["tasks", listId], queryFn: () => api.listTasks(listId!), enabled: Boolean(listId) });
  const setStatus = useMutation({ mutationFn: ({ id, statusId }: { id: string; statusId: string }) => api.updateTask(id, { statusId }), onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", listId] }) });
  const listName = (() => {
    for (const s of spaces) {
      const l = s.lists.find((x) => x.id === listId) ?? s.folders.flatMap((f) => f.lists).find((x) => x.id === listId);
      if (l) return `${s.name} › ${l.name}`;
    }
    return "List";
  })();
  const open = tasks.filter((t) => t.status?.category !== "done" && t.status?.category !== "closed");
  const done = tasks.filter((t) => t.status?.category === "done" || t.status?.category === "closed");
  return (
    <NodeViewWrapper className={`doc-embed doc-embed-list${selected ? " ProseMirror-selectednode" : ""}`} data-type="listEmbed" contentEditable={false}>
      {!listId ? (
        editable ? (
          <div className="doc-embed-pick">
            <span>▤ Embed a list</span>
            <select autoFocus defaultValue="" onChange={(e) => e.target.value && updateAttributes({ listId: e.target.value })} onMouseDown={(e) => e.stopPropagation()}>
              <option value="">Choose a list…</option>
              {spaces.map((s) => (
                <optgroup key={s.id} label={s.name}>
                  {s.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  {s.folders.flatMap((f) => f.lists.map((l) => <option key={l.id} value={l.id}>{f.name} / {l.name}</option>))}
                </optgroup>
              ))}
            </select>
          </div>
        ) : (
          <span className="doc-embed-empty">No list chosen.</span>
        )
      ) : (
        <>
          <div className="doc-embed-head">
            <span>▤ {listName}</span>
            <span className="doc-embed-count">{open.length} open{done.length ? ` · ${done.length} done` : ""}</span>
            {done.length > 0 && <button type="button" onMouseDown={(e) => { e.preventDefault(); setShowDone((v) => !v); }}>{showDone ? "Hide done" : "Show done"}</button>}
          </div>
          {isError ? (
            <span className="doc-embed-empty">This list is no longer available.</span>
          ) : (
            <div className="doc-embed-rows">
              {(showDone ? tasks : open).map((t) => <TaskRow key={t.id} task={t} editable={editable} onStatus={(statusId) => setStatus.mutate({ id: t.id, statusId })} />)}
              {open.length === 0 && !showDone && <span className="doc-embed-empty">Nothing open.</span>}
            </div>
          )}
        </>
      )}
    </NodeViewWrapper>
  );
}

export const TaskEmbed = Node.create({
  name: "taskEmbed",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { taskId: { default: null, parseHTML: (el) => el.getAttribute("data-task-id"), renderHTML: (a) => (a.taskId ? { "data-task-id": a.taskId } : {}) } };
  },
  parseHTML() {
    return [{ tag: "div[data-type=taskEmbed]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "taskEmbed", class: "doc-embed" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TaskEmbedView);
  },
  addCommands() {
    return { insertTaskEmbed: (taskId = null) => ({ chain }) => chain().insertContent({ type: this.name, attrs: { taskId } }).run() };
  },
});

export const ListEmbed = Node.create({
  name: "listEmbed",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { listId: { default: null, parseHTML: (el) => el.getAttribute("data-list-id"), renderHTML: (a) => (a.listId ? { "data-list-id": a.listId } : {}) } };
  },
  parseHTML() {
    return [{ tag: "div[data-type=listEmbed]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "listEmbed", class: "doc-embed" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ListEmbedView);
  },
  addCommands() {
    return { insertListEmbed: (listId = null) => ({ chain }) => chain().insertContent({ type: this.name, attrs: { listId } }).run() };
  },
});
