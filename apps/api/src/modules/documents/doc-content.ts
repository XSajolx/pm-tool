/**
 * Helpers over TipTap/ProseMirror JSON (row 65 + 67): drop internal-only
 * blocks before anything leaves the team, and flatten content to text lines.
 */
export interface PmNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function isInternal(node: PmNode) {
  return node.type === "callout" && node.attrs?.variant === "internal";
}

/** A deep copy without internal-only callouts. */
export function stripInternal<T extends PmNode>(node: T): T {
  const copy: PmNode = { ...node };
  if (Array.isArray(node.content)) copy.content = node.content.filter((c) => !isInternal(c)).map((c) => stripInternal(c));
  return copy as T;
}

/** Ids of every snippet block in a doc. */
export function snippetIds(node: PmNode, out = new Set<string>()): Set<string> {
  if (node.type === "snippetBlock" && typeof node.attrs?.snippetId === "string") out.add(node.attrs.snippetId);
  for (const c of node.content ?? []) snippetIds(c, out);
  return out;
}

/** Replace snippet blocks with the snippet's own blocks (row 66) — for share links and PDFs. */
export function expandSnippets<T extends PmNode>(node: T, lookup: Map<string, PmNode | null>): T {
  const copy: PmNode = { ...node };
  if (Array.isArray(node.content)) {
    copy.content = node.content.flatMap((c) => {
      if (c.type === "snippetBlock") {
        const id = typeof c.attrs?.snippetId === "string" ? c.attrs.snippetId : "";
        const snip = lookup.get(id);
        return snip?.content ? snip.content.map((n) => expandSnippets(n, lookup)) : [];
      }
      return [expandSnippets(c, lookup)];
    });
  }
  return copy as T;
}

/** Plain text of a node (block separator = newline). */
export function textOf(node: PmNode): string {
  if (node.text) return node.text;
  if (!node.content) return "";
  const parts = node.content.map(textOf);
  const blockish = ["paragraph", "heading", "listItem", "taskItem", "blockquote", "codeBlock", "callout", "tableRow", "toggleSummary", "toggleContent", "toggle", "bulletList", "orderedList", "taskList", "table"];
  return parts.filter((p, i) => p !== "" || i === 0).join(node.content.some((c) => blockish.includes(c.type ?? "")) ? "\n" : "");
}

export interface Line {
  text: string;
  style: "h1" | "h2" | "h3" | "p" | "li" | "quote" | "code" | "callout" | "blank";
}

/** Flatten a doc to styled lines — what the PDF renderer consumes (row 67). */
export function toLines(node: PmNode, depth = 0, out: Line[] = [], listCtx?: { ordered: boolean; n: number }): Line[] {
  for (const c of node.content ?? []) {
    if (isInternal(c)) continue;
    switch (c.type) {
      case "heading": {
        const lvl = Number(c.attrs?.level ?? 2);
        out.push({ text: textOf(c), style: lvl === 1 ? "h1" : lvl === 2 ? "h2" : "h3" });
        break;
      }
      case "paragraph": {
        const t = textOf(c);
        out.push({ text: (listCtx ? "" : "  ".repeat(Math.max(0, depth - 1))) + t, style: t ? "p" : "blank" });
        break;
      }
      case "bulletList":
      case "orderedList":
      case "taskList": {
        let n = 0;
        for (const li of c.content ?? []) {
          n += 1;
          const marker = c.type === "orderedList" ? `${n}. ` : c.type === "taskList" ? (li.attrs?.checked ? "[x] " : "[ ] ") : "• ";
          const first = li.content?.[0];
          const rest = (li.content ?? []).slice(1);
          out.push({ text: `${"  ".repeat(depth)}${marker}${first ? textOf(first) : ""}`, style: "li" });
          if (rest.length) toLines({ content: rest }, depth + 1, out);
        }
        break;
      }
      case "blockquote":
        for (const l of textOf(c).split("\n")) out.push({ text: `“${l}”`, style: "quote" });
        break;
      case "codeBlock":
        for (const l of textOf(c).split("\n")) out.push({ text: l, style: "code" });
        break;
      case "callout":
        for (const l of textOf(c).split("\n")) out.push({ text: l, style: "callout" });
        break;
      case "toggle": {
        const summary = c.content?.find((x) => x.type === "toggleSummary");
        const body = c.content?.find((x) => x.type === "toggleContent");
        if (summary) out.push({ text: `▸ ${textOf(summary)}`, style: "h3" });
        if (body) toLines(body, depth + 1, out);
        break;
      }
      case "table":
        for (const row of c.content ?? []) out.push({ text: (row.content ?? []).map((cell) => textOf(cell).replace(/\n/g, " ")).join("  |  "), style: "code" });
        out.push({ text: "", style: "blank" });
        break;
      case "horizontalRule":
        out.push({ text: "————————————", style: "p" });
        break;
      case "imageBlock":
        out.push({ text: `[Image${c.attrs?.alt ? `: ${String(c.attrs.alt)}` : ""}]`, style: "callout" });
        break;
      case "fileBlock":
        out.push({ text: `[File: ${String(c.attrs?.name ?? "attachment")}]`, style: "callout" });
        break;
      case "taskEmbed":
        out.push({ text: "[Embedded task - open the doc in the app for the live card]", style: "callout" });
        break;
      case "listEmbed":
        out.push({ text: "[Embedded task list - open the doc in the app for the live view]", style: "callout" });
        break;
      default:
        if (c.content) toLines(c, depth, out);
        else if (c.text) out.push({ text: c.text, style: "p" });
    }
  }
  return out;
}
