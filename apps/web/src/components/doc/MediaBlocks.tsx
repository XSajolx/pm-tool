import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";

/**
 * Row 13: images and files inside a doc. Both are atoms that point at an
 * uploaded attachment (the bytes live in file storage; the doc keeps the URL).
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mediaBlocks: {
      insertImageBlock: (attrs: { src: string; alt?: string; fileId?: string | null; width?: number | null }) => ReturnType;
      insertFileBlock: (attrs: { url: string; name: string; size?: number | null; mime?: string | null; fileId?: string | null }) => ReturnType;
    };
  }
}

export function fmtBytes(n: number | null | undefined) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
}
export function fileGlyph(mime: string | null | undefined, name: string) {
  const m = mime ?? "";
  if (m.includes("pdf")) return "📕";
  if (m.includes("zip") || m.includes("compressed")) return "🗜️";
  if (m.includes("sheet") || /\.(xlsx?|csv)$/i.test(name)) return "📊";
  if (m.includes("presentation") || /\.pptx?$/i.test(name)) return "📽️";
  if (m.includes("word") || /\.docx?$/i.test(name)) return "📝";
  if (m.startsWith("video/")) return "🎬";
  if (m.startsWith("audio/")) return "🎵";
  return "📄";
}

function ImageView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { src, alt, width } = node.attrs as { src: string; alt: string | null; width: number | null };
  const editable = editor.isEditable;
  return (
    <NodeViewWrapper className={`doc-image${selected ? " ProseMirror-selectednode" : ""}`} data-type="imageBlock">
      <img src={src} alt={alt ?? ""} style={width ? { width: `${width}%` } : undefined} draggable={false} />
      {editable ? (
        <div className="doc-image-tools" contentEditable={false}>
          {[25, 50, 75, 100].map((wPct) => (
            <button key={wPct} type="button" onMouseDown={(e) => { e.preventDefault(); updateAttributes({ width: wPct === 100 ? null : wPct }); }} className={width === wPct || (!width && wPct === 100) ? "on" : ""}>{wPct}%</button>
          ))}
          <input
            defaultValue={alt ?? ""}
            placeholder="Caption / alt text"
            onBlur={(e) => e.target.value !== (alt ?? "") && updateAttributes({ alt: e.target.value })}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
      ) : alt ? (
        <div className="doc-image-caption">{alt}</div>
      ) : null}
    </NodeViewWrapper>
  );
}

export const ImageBlock = Node.create({
  name: "imageBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: "", parseHTML: (el) => el.getAttribute("src") ?? el.querySelector("img")?.getAttribute("src") ?? "", renderHTML: (a) => ({ src: a.src }) },
      alt: { default: null, parseHTML: (el) => el.getAttribute("alt") ?? el.querySelector("img")?.getAttribute("alt"), renderHTML: (a) => (a.alt ? { alt: a.alt } : {}) },
      fileId: { default: null, parseHTML: (el) => el.getAttribute("data-file-id"), renderHTML: (a) => (a.fileId ? { "data-file-id": a.fileId } : {}) },
      width: { default: null, parseHTML: (el) => (el.getAttribute("data-width") ? Number(el.getAttribute("data-width")) : null), renderHTML: (a) => (a.width ? { "data-width": String(a.width) } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }, { tag: "figure[data-type=imageBlock]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { class: "doc-image-el" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
  addCommands() {
    return {
      insertImageBlock:
        (attrs) =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs }).run(),
    };
  },
});

function FileView({ node, selected }: NodeViewProps) {
  const { url, name, size, mime } = node.attrs as { url: string; name: string; size: number | null; mime: string | null };
  return (
    <NodeViewWrapper className={`doc-file${selected ? " ProseMirror-selectednode" : ""}`} data-type="fileBlock" contentEditable={false}>
      <a href={url} target="_blank" rel="noreferrer" draggable={false}>
        <span className="doc-file-glyph">{fileGlyph(mime, name)}</span>
        <span className="doc-file-name">{name}</span>
        {size ? <span className="doc-file-size">{fmtBytes(size)}</span> : null}
      </a>
    </NodeViewWrapper>
  );
}

export const FileBlock = Node.create({
  name: "fileBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      url: { default: "", parseHTML: (el) => el.getAttribute("data-url") ?? "", renderHTML: (a) => ({ "data-url": a.url }) },
      name: { default: "file", parseHTML: (el) => el.getAttribute("data-name") ?? "file", renderHTML: (a) => ({ "data-name": a.name }) },
      size: { default: null, parseHTML: (el) => (el.getAttribute("data-size") ? Number(el.getAttribute("data-size")) : null), renderHTML: (a) => (a.size ? { "data-size": String(a.size) } : {}) },
      mime: { default: null, parseHTML: (el) => el.getAttribute("data-mime"), renderHTML: (a) => (a.mime ? { "data-mime": a.mime } : {}) },
      fileId: { default: null, parseHTML: (el) => el.getAttribute("data-file-id"), renderHTML: (a) => (a.fileId ? { "data-file-id": a.fileId } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-type=fileBlock]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "fileBlock", class: "doc-file" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileView);
  },
  addCommands() {
    return {
      insertFileBlock:
        (attrs) =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs }).run(),
    };
  },
});
