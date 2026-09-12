/**
 * Block editor for documents (TipTap). Owns the slash menu, the selection
 * toolbar and debounced autosave; the page around it owns title, settings and
 * the side panel.
 */
import { useEffect, useRef, useState } from "react";
import { BubbleMenu, EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import TextAlign from "@tiptap/extension-text-align";
import type { DocSettings } from "../../lib/api.js";
import { Callout, CodeBlockWithCopy, Toggle, ToggleContent, ToggleSummary } from "./extensions.js";
import { SlashMenu, filterSlashItems, readSlashState, runSlashItem, type SlashState } from "./SlashMenu.js";

export interface DocEditorProps {
  docId: string;
  /** TipTap JSON, or null for docs that only have plain `body` text. */
  content: Record<string, unknown> | null;
  body: string;
  settings: DocSettings;
  onSave: (patch: { content: Record<string, unknown>; body: string }) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Legacy plain-text docs become one paragraph per line. */
function bodyToContent(body: string): Record<string, unknown> {
  const lines = body.split(/\r?\n/);
  return {
    type: "doc",
    content: lines.map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
  };
}

const SAVE_DELAY_MS = 800;

export function DocEditor({ docId, content, body, settings, onSave, onDirtyChange }: DocEditorProps) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashRef = useRef<SlashState | null>(null);
  slashRef.current = slash;
  const saveTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const flush = (editor: Editor) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    onDirtyChange?.(false);
    onSaveRef.current({ content: editor.getJSON() as Record<string, unknown>, body: editor.getText({ blockSeparator: "\n" }) });
  };

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ codeBlock: false, heading: { levels: [1, 2, 3] } }),
        CodeBlockWithCopy,
        Underline,
        Highlight,
        Link.configure({ openOnClick: false, autolink: true, defaultProtocol: "https" }),
        Placeholder.configure({
          placeholder: ({ node }) => {
            if (node.type.name === "heading") return "Heading";
            if (node.type.name === "toggleSummary") return "Toggle title";
            return "Type '/' for blocks, or just start writing…";
          },
          includeChildren: true,
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        TextStyle,
        Color,
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        Callout,
        Toggle,
        ToggleSummary,
        ToggleContent,
      ],
      content: content ?? (body ? bodyToContent(body) : undefined),
      editorProps: {
        attributes: { class: "doc-prose", spellcheck: "true" },
        handleKeyDown: (_view, event) => {
          const state = slashRef.current;
          if (!state) return false;
          const items = filterSlashItems(state.query);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!items.length) return true;
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setSlash({ ...state, index: (state.index + delta + items.length) % items.length });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const item = items[state.index];
            if (!item) return false;
            event.preventDefault();
            runSlashItem(editorRef.current!, state, item);
            setSlash(null);
            return true;
          }
          if (event.key === "Escape") {
            setSlash(null);
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => {
        dirtyRef.current = true;
        onDirtyChange?.(true);
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => flush(editor), SAVE_DELAY_MS);
        setSlash((prev) => readSlashState(editor, prev));
      },
      onSelectionUpdate: ({ editor }) => {
        setSlash((prev) => readSlashState(editor, prev));
      },
      onBlur: ({ editor }) => {
        // Save immediately on blur so nothing is lost when the user navigates away.
        flush(editor);
      },
    },
    [docId],
  );
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  // Flush pending edits when the editor unmounts (route change, doc switch).
  useEffect(() => {
    return () => {
      if (editorRef.current) flush(editorRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  if (!editor) return null;

  const font = settings.font ?? "sans";
  const size = settings.fontSize ?? "md";

  return (
    <div className={`doc-editor doc-font-${font} doc-size-${size}`}>
      <BubbleMenu editor={editor} tippyOptions={{ duration: 100, maxWidth: "none" }} shouldShow={({ editor, from, to }) => from !== to && !editor.isActive("codeBlock")}>
        <SelectionToolbar editor={editor} />
      </BubbleMenu>
      <BubbleMenu
        editor={editor}
        pluginKey="tableMenu"
        tippyOptions={{ duration: 100, placement: "top-start", maxWidth: "none" }}
        shouldShow={({ editor }) => editor.isActive("table")}
      >
        <TableToolbar editor={editor} />
      </BubbleMenu>
      <EditorContent editor={editor} />
      {slash && (
        <SlashMenu
          state={slash}
          onHover={(index) => setSlash({ ...slash, index })}
          onPick={(item) => {
            runSlashItem(editor, slash, item);
            setSlash(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Floating toolbar shown on text selection
 * ------------------------------------------------------------------ */
const TEXT_COLORS = ["#0f172a", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#7c3aed", "#db2777"];

function SelectionToolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");

  const blockValue = editor.isActive("heading", { level: 1 })
    ? "h1"
    : editor.isActive("heading", { level: 2 })
      ? "h2"
      : editor.isActive("heading", { level: 3 })
        ? "h3"
        : "p";

  const applyLink = () => {
    const href = linkValue.trim();
    if (href) editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    else editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkOpen(false);
  };

  if (linkOpen) {
    return (
      <div className="bubble-bar">
        <input
          autoFocus
          value={linkValue}
          onChange={(e) => setLinkValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyLink();
            }
            if (e.key === "Escape") setLinkOpen(false);
          }}
          placeholder="Paste a link…"
          className="w-56 rounded border border-border px-2 py-1 text-xs outline-none focus:border-indigo-400"
        />
        <button type="button" className="bubble-btn" onMouseDown={(e) => { e.preventDefault(); applyLink(); }}>Apply</button>
        <button type="button" className="bubble-btn" onMouseDown={(e) => { e.preventDefault(); setLinkValue(""); applyLink(); }}>Remove</button>
      </div>
    );
  }

  const Btn = ({ active, label, title, onClick, className = "" }: { active?: boolean; label: React.ReactNode; title: string; onClick: () => void; className?: string }) => (
    <button
      type="button"
      title={title}
      className={`bubble-btn ${active ? "bubble-btn-active" : ""} ${className}`}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="bubble-bar">
      <select
        value={blockValue}
        title="Text style"
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "p") editor.chain().focus().setParagraph().run();
          else editor.chain().focus().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
        }}
        className="bubble-select"
      >
        <option value="p">Text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="bubble-sep" />
      <Btn active={editor.isActive("bold")} label={<b>B</b>} title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()} />
      <Btn active={editor.isActive("italic")} label={<i>I</i>} title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()} />
      <Btn active={editor.isActive("underline")} label={<u>U</u>} title="Underline (Ctrl+U)" onClick={() => editor.chain().focus().toggleUnderline().run()} />
      <Btn active={editor.isActive("strike")} label={<s>S</s>} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} />
      <Btn active={editor.isActive("code")} label={<code>{"<>"}</code>} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()} />
      <Btn active={editor.isActive("highlight")} label={<span className="rounded bg-yellow-200 px-1">H</span>} title="Highlight" onClick={() => editor.chain().focus().toggleHighlight().run()} />
      <Btn
        active={editor.isActive("link")}
        label="🔗"
        title="Link"
        onClick={() => {
          setLinkValue((editor.getAttributes("link").href as string | undefined) ?? "");
          setLinkOpen(true);
        }}
      />
      <span className="bubble-sep" />
      <div className="flex items-center gap-0.5" title="Text colour">
        {TEXT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`bubble-swatch ${editor.isActive("textStyle", { color: c }) ? "ring-2 ring-indigo-400" : ""}`}
            style={{ background: c }}
            onMouseDown={(e) => {
              e.preventDefault();
              if (c === TEXT_COLORS[0]) editor.chain().focus().unsetColor().run();
              else editor.chain().focus().setColor(c).run();
            }}
          />
        ))}
      </div>
      <span className="bubble-sep" />
      <Btn active={editor.isActive({ textAlign: "left" })} label="⇤" title="Align left" onClick={() => editor.chain().focus().setTextAlign("left").run()} />
      <Btn active={editor.isActive({ textAlign: "center" })} label="↔" title="Align centre" onClick={() => editor.chain().focus().setTextAlign("center").run()} />
      <Btn active={editor.isActive({ textAlign: "right" })} label="⇥" title="Align right" onClick={() => editor.chain().focus().setTextAlign("right").run()} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Table controls, shown while the caret is inside a table
 * ------------------------------------------------------------------ */
function TableToolbar({ editor }: { editor: Editor }) {
  const B = ({ label, title, onClick, danger }: { label: string; title: string; onClick: () => void; danger?: boolean }) => (
    <button
      type="button"
      title={title}
      className={`bubble-btn ${danger ? "text-red-600" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="bubble-bar">
      <B label="+ Row" title="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()} />
      <B label="+ Col" title="Add column after" onClick={() => editor.chain().focus().addColumnAfter().run()} />
      <B label="− Row" title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()} />
      <B label="− Col" title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()} />
      <span className="bubble-sep" />
      <B label="Header row" title="Toggle header row" onClick={() => editor.chain().focus().toggleHeaderRow().run()} />
      <B label="Merge" title="Merge or split cells" onClick={() => editor.chain().focus().mergeOrSplit().run()} />
      <span className="bubble-sep" />
      <B label="Delete table" title="Delete table" danger onClick={() => editor.chain().focus().deleteTable().run()} />
    </div>
  );
}
