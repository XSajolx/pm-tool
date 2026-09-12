/**
 * "/" command menu for the doc editor. Typing "/" at the start of a line (or
 * after a space) opens a searchable list of blocks; Enter inserts the block and
 * removes the typed "/query" text. Keyboard handling lives in DocEditor's
 * handleKeyDown, which reads the menu state through a ref.
 */
import type { Editor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import { CALLOUTS, type CalloutVariant } from "./extensions.js";

export interface SlashItem {
  id: string;
  label: string;
  hint: string;
  icon: string;
  group: "Text" | "Lists" | "Blocks";
  keywords?: string;
  run: (editor: Editor) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: "text", label: "Normal text", hint: "Plain paragraph", icon: "T", group: "Text", keywords: "p paragraph", run: (e) => e.chain().focus().setParagraph().run() },
  { id: "h1", label: "Heading 1", hint: "Large section heading", icon: "H1", group: "Text", keywords: "h1 title", run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", hint: "Medium section heading", icon: "H2", group: "Text", keywords: "h2 subtitle", run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", hint: "Small section heading", icon: "H3", group: "Text", keywords: "h3", run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { id: "quote", label: "Quote", hint: "Pull quote or citation", icon: "❝", group: "Text", keywords: "blockquote", run: (e) => e.chain().focus().setBlockquote().run() },
  { id: "bullets", label: "Bulleted list", hint: "Simple bullet list", icon: "•", group: "Lists", keywords: "ul", run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "numbered", label: "Numbered list", hint: "List with numbers", icon: "1.", group: "Lists", keywords: "ol ordered", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "checklist", label: "Checklist", hint: "To-do items with checkboxes", icon: "☑", group: "Lists", keywords: "todo task", run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: "toggle", label: "Toggle list", hint: "Collapsible section", icon: "▸", group: "Lists", keywords: "collapse details", run: (e) => e.chain().focus().insertToggle().run() },
  { id: "table", label: "Table", hint: "3 × 3 table with a header row", icon: "▦", group: "Blocks", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ...(Object.keys(CALLOUTS) as CalloutVariant[]).map<SlashItem>((variant) => ({
    id: `callout-${variant}`,
    label: CALLOUTS[variant].label,
    hint: "Coloured callout box",
    icon: CALLOUTS[variant].emoji,
    group: "Blocks",
    keywords: "banner callout",
    run: (e) => e.chain().focus().insertCallout(variant).run(),
  })),
  { id: "code", label: "Code block", hint: "Monospace with copy button", icon: "</>", group: "Blocks", run: (e) => e.chain().focus().setCodeBlock().run() },
  { id: "divider", label: "Divider", hint: "Horizontal rule", icon: "—", group: "Blocks", keywords: "hr line", run: (e) => e.chain().focus().setHorizontalRule().run() },
];

export function filterSlashItems(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  // Match on the label/hint/keywords, and on compact forms like "h1" or "bl" for "Bulleted list".
  return SLASH_ITEMS.filter((i) => {
    const haystack = `${i.label} ${i.hint} ${i.keywords ?? ""}`.toLowerCase();
    const compact = i.label.toLowerCase().replace(/\s+/g, "");
    return haystack.includes(q) || compact.startsWith(q.replace(/\s+/g, ""));
  });
}

export interface SlashState {
  /** Document position of the "/" character. */
  from: number;
  /** Position right after the query text (the caret). */
  to: number;
  query: string;
  index: number;
  /** Viewport coordinates for the popup. */
  left: number;
  top: number;
}

/**
 * Returns the slash state for the current selection, or null when no "/query"
 * precedes the caret in the current text block.
 */
export function readSlashState(editor: Editor, prev: SlashState | null): SlashState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const match = /(?:^|\s)\/([^/\s]*(?:\s[^/\s]*)*)$/.exec(textBefore);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.length > 30) return null;
  const from = $from.pos - query.length - 1;
  const coords = editor.view.coordsAtPos(from);
  return {
    from,
    to: $from.pos,
    query,
    index: prev && prev.from === from ? Math.min(prev.index, Math.max(filterSlashItems(query).length - 1, 0)) : 0,
    left: coords.left,
    top: coords.bottom + 4,
  };
}

/** Insert `item`, replacing the typed "/query". */
export function runSlashItem(editor: Editor, state: SlashState, item: SlashItem) {
  editor.chain().focus().deleteRange({ from: state.from, to: state.to }).run();
  item.run(editor);
}

export function SlashMenu({
  state,
  onPick,
  onHover,
}: {
  state: SlashState;
  onPick: (item: SlashItem) => void;
  onHover: (index: number) => void;
}) {
  const items = filterSlashItems(state.query);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${state.index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [state.index]);

  // Keep the popup on-screen: flip above the caret when there's no room below.
  const height = 320;
  const top = state.top + height > window.innerHeight ? Math.max(8, state.top - height - 28) : state.top;
  const left = Math.min(state.left, window.innerWidth - 300);

  if (!items.length) {
    return (
      <div className="slash-menu" style={{ left, top }}>
        <p className="px-3 py-2 text-xs text-muted-foreground">No matching blocks</p>
      </div>
    );
  }

  let lastGroup = "";
  return (
    <div ref={listRef} className="slash-menu" style={{ left, top, maxHeight: height }} role="listbox">
      {items.map((item, i) => {
        const showGroup = item.group !== lastGroup;
        lastGroup = item.group;
        return (
          <div key={item.id}>
            {showGroup && <p className="slash-group">{item.group}</p>}
            <button
              type="button"
              role="option"
              aria-selected={i === state.index}
              data-index={i}
              className={`slash-item ${i === state.index ? "slash-item-active" : ""}`}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item);
              }}
            >
              <span className="slash-icon">{item.icon}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm text-slate-800">{item.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{item.hint}</span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
