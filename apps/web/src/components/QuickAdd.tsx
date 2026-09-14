import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { parseQuickAdd } from "../lib/quickParse.js";
import { PRIORITY } from "./ui.js";

const LAST_LIST_KEY = "pm:quickAddList";

/**
 * Quick-add (row 37): press "n" anywhere (or click "New task" in the sidebar)
 * to capture a task in one line. Dates like "tomorrow" or "fri", "!high",
 * "@name" and "#tag" are parsed out of the text and shown as chips before
 * you press Enter.
 */
export function QuickAdd({
  open,
  onClose,
  initialText,
  source,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Row 47: pre-filled title, e.g. the chat message being turned into a task. */
  initialText?: string;
  /** Row 47: the chat message this task comes from — stored on the task and quoted in its description. */
  source?: { messageId: string; channelId: string; channelName: string; authorName: string; body: string };
  onCreated?: (task: { id: string; title: string; reference: string | null }) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { listId?: string };
  const [text, setText] = useState("");
  const [listId, setListId] = useState("");
  const [done, setDone] = useState<{ id: string; title: string; listId: string; listName: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces, enabled: open });
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers, enabled: open });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => api.getTags(), enabled: open });

  const lists = useMemo(
    () =>
      spaces.flatMap((sp) => [
        ...sp.lists.map((l) => ({ id: l.id, name: l.name, label: `${sp.name} › ${l.name}`, spaceId: sp.id })),
        ...sp.folders.flatMap((f) => f.lists.map((l) => ({ id: l.id, name: l.name, label: `${sp.name} › ${f.name} › ${l.name}`, spaceId: sp.id }))),
      ]),
    [spaces],
  );

  // Default target: the list you're looking at, else the last one used, else the first list.
  useEffect(() => {
    if (!open || !lists.length) return;
    const remembered = (() => {
      try {
        return localStorage.getItem(LAST_LIST_KEY);
      } catch {
        return null;
      }
    })();
    const pick = params.listId && lists.some((l) => l.id === params.listId) ? params.listId : remembered && lists.some((l) => l.id === remembered) ? remembered : lists[0]!.id;
    setListId(pick);
  }, [open, lists, params.listId]);

  useEffect(() => {
    if (open) {
      setDone(null);
      if (initialText) setText(initialText);
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setText("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsed = useMemo(() => parseQuickAdd(text), [text]);
  const matchedMembers = useMemo(
    () =>
      parsed.assignees
        .map((h) => members.find((m) => m.name.toLowerCase().split(/\s+/).some((part) => part.startsWith(h)) || m.email.toLowerCase().startsWith(h)))
        .filter((m): m is NonNullable<typeof m> => Boolean(m)),
    [parsed.assignees, members],
  );

  const create = useMutation({
    mutationFn: async () => {
      const target = lists.find((l) => l.id === listId)!;
      const task = await api.createTask({
        listId,
        title: parsed.title || text.trim(),
        dueDate: parsed.dueDate,
        priority: parsed.priority,
        assigneeIds: matchedMembers.map((m) => m.id),
        sourceMessageId: source?.messageId,
        description: source ? `From ${source.channelName} — ${source.authorName} wrote:\n> ${source.body.replace(/\n/g, "\n> ")}` : undefined,
      });
      for (const name of parsed.tags) {
        const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? (await api.createTag({ name }));
        await api.addTaskTag(task.id, existing.id);
      }
      return { task, target };
    },
    onSuccess: ({ task, target }) => {
      try {
        localStorage.setItem(LAST_LIST_KEY, listId);
      } catch {
        /* ignore */
      }
      qc.invalidateQueries({ queryKey: ["tasks", listId] });
      qc.invalidateQueries({ queryKey: ["my-tasks"] });
      qc.invalidateQueries({ queryKey: ["tags"] });
      setDone({ id: task.id, title: task.title, listId, listName: target.name });
      setText("");
      inputRef.current?.focus();
      onCreated?.({ id: task.id, title: task.title, reference: task.reference });
    },
  });

  if (!open) return null;
  const canSubmit = Boolean(listId) && Boolean(parsed.title || text.trim()) && !create.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[18vh]" onClick={onClose}>
      <div className="w-[600px] max-w-[92vw] rounded-xl border border-border bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          {source && (
            <div className="flex items-start gap-2 border-b border-border bg-[#fbfbfa] px-4 py-2 text-xs text-slate-600">
              <span>💬</span>
              <span className="min-w-0">
                <span className="font-medium text-slate-800">{source.authorName}</span> in {source.channelName}:{" "}
                <span className="line-clamp-2 text-muted-foreground">{source.body}</span>
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <span className="text-lg">＋</span>
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && onClose()}
              placeholder="Send client update tomorrow !high @siam #client-review"
              className="flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-300"
            />
            <kbd className="rounded border border-border px-1.5 text-[10px] text-slate-400">esc</kbd>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
            <select value={listId} onChange={(e) => setListId(e.target.value)} className="max-w-[260px] rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700">
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            {parsed.dueLabel && <Chip tone="amber">📅 {parsed.dueLabel}</Chip>}
            {parsed.priority && <Chip tone="red">! {PRIORITY[parsed.priority].label}</Chip>}
            {matchedMembers.map((m) => (
              <Chip key={m.id} tone="indigo">
                @ {m.name}
              </Chip>
            ))}
            {parsed.assignees.length > matchedMembers.length && <Chip tone="slate">@ no match</Chip>}
            {parsed.tags.map((t) => (
              <Chip key={t} tone="green">
                # {t}
              </Chip>
            ))}
            <button type="submit" disabled={!canSubmit} className="ml-auto rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-40">
              {create.isPending ? "Adding…" : "Add task ↵"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            <span>Dates: today, tomorrow, fri, next mon, in 3 days, sep 30</span>
            <span>Priority: !high or !1–!4</span>
            <span>@person · #tag</span>
            {done && (
              <span className="ml-auto text-green-700">
                Added “{done.title}” to {done.listName}.{" "}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate({ to: "/t/$taskId", params: { taskId: done.id } });
                  }}
                  className="underline"
                >
                  Open
                </button>
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function Chip({ tone, children }: { tone: "amber" | "red" | "indigo" | "green" | "slate"; children: React.ReactNode }) {
  const cls = {
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
    green: "bg-green-50 text-green-700 border-green-200",
    slate: "bg-slate-100 text-slate-600 border-slate-200",
  }[tone];
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}

/** Global "n" shortcut: opens quick-add unless the user is typing somewhere. */
export function useQuickAddShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      e.preventDefault();
      open();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
}
