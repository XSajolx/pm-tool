/**
 * Custom TipTap nodes for the doc editor: banner/callout, toggle list, and a
 * code block with a copy button. Everything else comes from stock extensions.
 */
import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { CodeBlock } from "@tiptap/extension-code-block";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";

/**
 * Enter on an empty trailing paragraph inside a container block (callout,
 * toggle content) leaves the container: the empty paragraph is removed and a
 * fresh paragraph is placed after the container. Same feel as exiting a list.
 */
function exitContainerOnEmptyEnter(editor: Editor, containerName: string, exitDepthFromParagraph: number): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty) return false;
  const para = $from.parent;
  if (para.type.name !== "paragraph" || para.content.size !== 0) return false;
  const containerDepth = $from.depth - exitDepthFromParagraph;
  if (containerDepth < 1) return false;
  const container = $from.node(containerDepth);
  if (container.type.name !== containerName) return false;
  // Only when the empty paragraph is the last block of its parent and there is at least one other block.
  const parent = $from.node($from.depth - 1);
  if (parent.childCount < 2 || $from.index($from.depth - 1) !== parent.childCount - 1) return false;
  const paraPos = $from.before();
  const afterContainer = $from.after(containerDepth);
  return editor
    .chain()
    .command(({ tr }) => {
      tr.delete(paraPos, paraPos + para.nodeSize);
      const insertAt = afterContainer - para.nodeSize;
      tr.insert(insertAt, editor.schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
      return true;
    })
    .run();
}

/** Position of the first `typeName` node at or after `from` (the node insertContent just added). */
function findInsertedNode(doc: import("@tiptap/pm/model").Node, from: number, typeName: string): number | null {
  let found: number | null = null;
  doc.nodesBetween(Math.max(0, from - 1), doc.content.size, (node, pos) => {
    if (found !== null) return false;
    if (node.type.name === typeName && pos >= from - 1) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/* ------------------------------------------------------------------ *
 * Callout / banner
 * ------------------------------------------------------------------ */
export type CalloutVariant = "info" | "warning" | "success" | "note" | "internal";

export const CALLOUTS: Record<CalloutVariant, { label: string; emoji: string }> = {
  info: { label: "Info banner", emoji: "💡" },
  warning: { label: "Warning banner", emoji: "⚠️" },
  success: { label: "Success banner", emoji: "✅" },
  note: { label: "Note banner", emoji: "📝" },
  /** Row 65: team-only — stripped from share links and PDF exports. */
  internal: { label: "Internal note", emoji: "🔒" },
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      insertCallout: (variant: CalloutVariant) => ReturnType;
      setCalloutVariant: (variant: CalloutVariant) => ReturnType;
    };
    toggle: {
      insertToggle: () => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "paragraph+",
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: "info",
        parseHTML: (el) => el.getAttribute("data-callout") ?? "info",
        renderHTML: (attrs) => ({ "data-callout": attrs.variant }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: `callout callout-${node.attrs.variant}` }), 0];
  },

  addKeyboardShortcuts() {
    return {
      // paragraph is a direct child of the callout (depth - 1).
      Enter: ({ editor }) => exitContainerOnEmptyEnter(editor, this.name, 1),
    };
  },

  addCommands() {
    return {
      insertCallout:
        (variant) =>
        ({ chain, state }) =>
          chain()
            .insertContent({ type: this.name, attrs: { variant }, content: [{ type: "paragraph" }] })
            // insertContent leaves the caret after the node; put it inside the new paragraph.
            .command(({ tr }) => {
              const pos = findInsertedNode(tr.doc, state.selection.from, "callout");
              if (pos !== null) tr.setSelection(TextSelection.create(tr.doc, pos + 2));
              return true;
            })
            .run(),
      setCalloutVariant:
        (variant) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { variant }),
    };
  },
});

/* ------------------------------------------------------------------ *
 * Toggle list — a summary line plus collapsible block content.
 * ------------------------------------------------------------------ */
function ToggleView({ node, updateAttributes }: NodeViewProps) {
  const open = node.attrs.open as boolean;
  return (
    <NodeViewWrapper className={`toggle ${open ? "toggle-open" : "toggle-closed"}`} data-type="toggle">
      <button
        type="button"
        contentEditable={false}
        className="toggle-chevron"
        aria-label={open ? "Collapse" : "Expand"}
        onMouseDown={(e) => {
          e.preventDefault();
          updateAttributes({ open: !open });
        }}
      >
        <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
          <path d="M7 5l6 5-6 5z" />
        </svg>
      </button>
      <NodeViewContent className="toggle-body" />
    </NodeViewWrapper>
  );
}

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "toggleSummary toggleContent",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.getAttribute("data-open") !== "false",
        renderHTML: (attrs) => ({ "data-open": String(attrs.open) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="toggle"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggle", class: "toggle" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },

  addCommands() {
    return {
      insertToggle:
        () =>
        ({ chain, state }) =>
          chain()
            .insertContent({
              type: this.name,
              attrs: { open: true },
              content: [
                { type: "toggleSummary" },
                { type: "toggleContent", content: [{ type: "paragraph" }] },
              ],
            })
            // Start typing in the summary line, not in the hidden content.
            .command(({ tr }) => {
              const pos = findInsertedNode(tr.doc, state.selection.from, "toggle");
              if (pos !== null) tr.setSelection(TextSelection.create(tr.doc, pos + 2));
              return true;
            })
            .run(),
    };
  },
});

export const ToggleSummary = Node.create({
  name: "toggleSummary",
  content: "inline*",
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-type="toggle-summary"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggle-summary", class: "toggle-summary" }), 0];
  },

  addKeyboardShortcuts() {
    return {
      // Enter on the summary line jumps into the toggle's content instead of
      // splitting the summary (which the schema would reject anyway).
      Enter: ({ editor }) => {
        const { $from } = editor.state.selection;
        if ($from.parent.type.name !== this.name) return false;
        const togglePos = $from.before(-1);
        const contentStart = togglePos + 1 + $from.parent.nodeSize + 1;
        return editor
          .chain()
          .command(({ tr }) => {
            const toggle = tr.doc.nodeAt(togglePos);
            if (toggle && !toggle.attrs.open) tr.setNodeMarkup(togglePos, undefined, { ...toggle.attrs, open: true });
            return true;
          })
          .setTextSelection(contentStart + 1)
          .run();
      },
    };
  },
});

export const ToggleContent = Node.create({
  name: "toggleContent",
  content: "block+",
  defining: true,

  addKeyboardShortcuts() {
    return {
      // paragraph → toggleContent → toggle: exit the whole toggle (depth - 2).
      Enter: ({ editor }) => exitContainerOnEmptyEnter(editor, "toggle", 2),
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="toggle-content"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggle-content", class: "toggle-content" }), 0];
  },
});

/* ------------------------------------------------------------------ *
 * Code block with language label + copy button
 * ------------------------------------------------------------------ */
const LANGUAGES = ["plain", "ts", "js", "tsx", "json", "html", "css", "sql", "bash", "python", "go", "php"];

function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language = (node.attrs.language as string | null) ?? "plain";
  return (
    <NodeViewWrapper className="code-block">
      <div className="code-block-bar" contentEditable={false}>
        <select
          value={language}
          onChange={(e) => updateAttributes({ language: e.target.value === "plain" ? null : e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(node.textContent).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <NodeViewContent as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeBlockWithCopy = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
