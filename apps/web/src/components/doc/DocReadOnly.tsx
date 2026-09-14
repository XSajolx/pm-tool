import { EditorContent, useEditor } from "@tiptap/react";
import type { DocSettings } from "../../lib/api.js";
import { bodyToContent, docExtensions } from "./DocEditor.js";

/** Renders doc JSON with the same block styling as the editor, but read-only (share page, previews). */
export function DocReadOnly({ content, body, settings }: { content: Record<string, unknown> | null; body: string; settings?: DocSettings }) {
  const editor = useEditor({
    editable: false,
    extensions: docExtensions(),
    content: content ?? (body ? bodyToContent(body) : undefined),
    editorProps: { attributes: { class: "doc-prose" } },
  });
  if (!editor) return null;
  return (
    <div className={`doc-editor doc-font-${settings?.font ?? "sans"} doc-size-${settings?.fontSize ?? "md"}`}>
      <EditorContent editor={editor} />
    </div>
  );
}
