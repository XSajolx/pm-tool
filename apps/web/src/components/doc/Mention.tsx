import { useEffect, useMemo, useRef } from "react";
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../../lib/api.js";

/**
 * Row 15: "@" in a doc mentions a teammate, a task or another doc. The node
 * keeps kind + id + label; people get an inbox item when a save adds them.
 */
export type MentionKind = "user" | "task" | "document";

export interface MentionState {
  from: number;
  to: number;
  query: string;
  index: number;
  left: number;
  top: number;
}
export interface MentionItem {
  kind: MentionKind;
  id: string;
  label: string;
  hint?: string;
}

/** Same detection idea as the slash menu, for "@query" before the caret. */
export function readMentionState(editor: Editor, prev: MentionState | null, count: number): MentionState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /(?:^|\s)@([^@\s]*(?:\s[^@\s]*){0,2})$/.exec(textBefore);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.length > 40) return null;
  const from = $from.pos - query.length - 1;
  const coords = editor.view.coordsAtPos(from);
  return { from, to: $from.pos, query, index: prev && prev.from === from ? Math.min(prev.index, Math.max(count - 1, 0)) : 0, left: coords.left, top: coords.bottom + 4 };
}

export function insertMention(editor: Editor, state: MentionState, item: MentionItem) {
  editor
    .chain()
    .focus()
    .deleteRange({ from: state.from, to: state.to })
    .insertContent([{ type: "mention", attrs: { kind: item.kind, id: item.id, label: item.label } }, { type: "text", text: " " }])
    .run();
}

/** Members first (always), then tasks and docs from global search once the query has two letters. */
export function useMentionItems(query: string): MentionItem[] {
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const q = query.trim().toLowerCase();
  const { data: hits } = useQuery({ queryKey: ["search", q], queryFn: () => api.search(q, 5), enabled: q.length >= 2 });
  return useMemo(() => {
    const people = members
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .slice(0, 6)
      .map((m) => ({ kind: "user" as const, id: m.id, label: m.name, hint: m.email }));
    const tasks = (hits?.groups.find((g) => g.type === "task")?.items ?? []).slice(0, 4).map((h) => ({ kind: "task" as const, id: h.id, label: h.title, hint: h.subtitle }));
    const docs = (hits?.groups.find((g) => g.type === "document")?.items ?? []).slice(0, 4).map((h) => ({ kind: "document" as const, id: h.id, label: h.title.replace(/^\S+\s/, (m) => (/\p{Emoji}/u.test(m) ? "" : m)), hint: "Doc" }));
    return [...people, ...tasks, ...docs];
  }, [members, hits, q]);
}

const ICON: Record<MentionKind, string> = { user: "👤", task: "☐", document: "📄" };

export function MentionMenu({ state, items, onPick, onHover }: { state: MentionState; items: MentionItem[]; onPick: (item: MentionItem) => void; onHover: (i: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${state.index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [state.index]);
  const height = 280;
  const top = state.top + height > window.innerHeight ? Math.max(8, state.top - height - 28) : state.top;
  const left = Math.min(state.left, window.innerWidth - 300);
  return (
    <div ref={listRef} className="slash-menu" style={{ left, top, maxHeight: height }} role="listbox" data-testid="mention-menu">
      {items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No one and nothing matches "@{state.query}"</p>
      ) : (
        items.map((item, i) => (
          <button
            key={`${item.kind}:${item.id}`}
            type="button"
            role="option"
            aria-selected={i === state.index}
            data-index={i}
            className={`slash-item ${i === state.index ? "slash-item-active" : ""}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
          >
            <span className="slash-icon">{ICON[item.kind]}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm text-slate-800">{item.label}</span>
              {item.hint && <span className="block truncate text-[11px] text-muted-foreground">{item.hint}</span>}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function MentionView({ node }: NodeViewProps) {
  const { kind, id, label } = node.attrs as { kind: MentionKind; id: string; label: string };
  const cls = `doc-mention doc-mention-${kind}`;
  if (kind === "task") return <NodeViewWrapper as="span" className={cls}><Link to="/t/$taskId" params={{ taskId: id }}>☐ {label}</Link></NodeViewWrapper>;
  if (kind === "document") return <NodeViewWrapper as="span" className={cls}><Link to="/docs/$docId" params={{ docId: id }}>📄 {label}</Link></NodeViewWrapper>;
  return <NodeViewWrapper as="span" className={cls} title={label}>@{label}</NodeViewWrapper>;
}

export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: "user", parseHTML: (el) => el.getAttribute("data-kind") ?? "user", renderHTML: (a) => ({ "data-kind": a.kind }) },
      id: { default: "", parseHTML: (el) => el.getAttribute("data-id") ?? "", renderHTML: (a) => ({ "data-id": a.id }) },
      label: { default: "", parseHTML: (el) => el.getAttribute("data-label") ?? el.textContent ?? "", renderHTML: (a) => ({ "data-label": a.label }) },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-type=mention]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "mention", class: `doc-mention doc-mention-${node.attrs.kind}` }), `@${node.attrs.label}`];
  },
  renderText({ node }) {
    return `@${node.attrs.label}`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(MentionView);
  },
});
