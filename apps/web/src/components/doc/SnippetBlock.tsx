import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { DocReadOnly } from "./DocReadOnly.js";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    snippetBlock: {
      insertSnippet: (snippetId?: string | null) => ReturnType;
    };
  }
}

/**
 * Row 66: a block that shows a snippet by reference. The content lives on the
 * snippet, so editing it in Settings updates every doc that embeds it.
 * "Detach" swaps the reference for a plain copy you can edit here.
 */
export const SnippetBlock = Node.create({
  name: "snippetBlock",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      snippetId: { default: null, parseHTML: (el) => el.getAttribute("data-snippet-id"), renderHTML: (attrs) => ({ "data-snippet-id": attrs.snippetId }) },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-snippet-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "snippet-block" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SnippetView);
  },

  addCommands() {
    return {
      insertSnippet:
        (snippetId = null) =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs: { snippetId } }).run(),
    };
  },
});

function SnippetView({ node, updateAttributes, editor, getPos, deleteNode }: NodeViewProps) {
  const id = node.attrs.snippetId as string | null;
  const { data: list = [] } = useQuery({ queryKey: ["snippets"], queryFn: api.getSnippets, enabled: !id });
  const { data: snippet, isError } = useQuery({ queryKey: ["snippet", id], queryFn: () => api.getSnippet(id!), enabled: Boolean(id), staleTime: 10_000 });
  const editable = editor.isEditable;

  const detach = () => {
    if (!snippet?.content) return;
    const blocks = ((snippet.content as { content?: unknown[] }).content ?? []) as Record<string, unknown>[];
    const pos = typeof getPos === "function" ? getPos() : null;
    if (pos === null || pos === undefined) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .insertContentAt(pos, blocks)
      .run();
  };

  return (
    <NodeViewWrapper className="snippet-block" data-snippet-id={id ?? ""} contentEditable={false}>
      {!id ? (
        <div className="snippet-pick">
          <span className="snippet-label">⟲ Insert snippet</span>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) updateAttributes({ snippetId: e.target.value });
            }}
          >
            <option value="">Choose a snippet…</option>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {editable && (
            <button type="button" onClick={() => deleteNode()} title="Remove">
              ✕
            </button>
          )}
        </div>
      ) : isError ? (
        <div className="snippet-pick">
          <span className="snippet-label">⟲ Snippet no longer exists</span>
          {editable && (
            <button type="button" onClick={() => deleteNode()}>
              Remove
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="snippet-head">
            <span className="snippet-label">⟲ {snippet?.name ?? "Snippet"} · synced</span>
            {editable && (
              <span className="snippet-actions">
                <button type="button" onClick={detach} title="Turn into editable text (stops syncing)">
                  Detach
                </button>
                <button type="button" onClick={() => deleteNode()} title="Remove">
                  ✕
                </button>
              </span>
            )}
          </div>
          {snippet ? <DocReadOnly content={snippet.content} body={snippet.body} /> : <p className="snippet-loading">Loading…</p>}
        </>
      )}
    </NodeViewWrapper>
  );
}
