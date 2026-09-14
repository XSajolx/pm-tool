/**
 * A tiny dependency-free PDF writer for text documents (row 57: every sent
 * proposal version gets a frozen PDF). Helvetica only, A4, word-wrapped,
 * paginated. Good enough for a proposal; swap for a real renderer later.
 */
export interface PdfDoc {
  title: string;
  subtitle?: string;
  meta?: string[];
  sections: { title: string; body: string }[];
  footer?: string;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const LINE = 14;

function esc(s: string) {
  // Keep to Latin-1 so the standard font can show it; anything else becomes "?".
  return s
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if ((line + " " + word).trim().length > maxChars && line) {
        out.push(line);
        line = word;
      } else {
        line = (line ? line + " " : "") + word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function renderPdf(doc: PdfDoc): Buffer {
  type Op = { text: string; size: number; bold?: boolean; gap?: number };
  const ops: Op[] = [];
  ops.push({ text: doc.title, size: 20, bold: true, gap: 6 });
  if (doc.subtitle) ops.push({ text: doc.subtitle, size: 11, gap: 2 });
  for (const m of doc.meta ?? []) ops.push({ text: m, size: 9 });
  ops.push({ text: "", size: 10, gap: 10 });
  for (const sec of doc.sections) {
    ops.push({ text: sec.title, size: 13, bold: true, gap: 4 });
    for (const l of wrap(sec.body || "—", 92)) ops.push({ text: l, size: 10 });
    ops.push({ text: "", size: 10, gap: 8 });
  }

  // Lay out into pages.
  const pages: string[][] = [];
  let cur: string[] = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => {
    if (cur.length) pages.push(cur);
    cur = [];
    y = PAGE_H - MARGIN;
  };
  for (const op of ops) {
    const h = Math.max(LINE, op.size * 1.35);
    if (y - h < MARGIN + 20) newPage();
    if (op.text !== "") {
      cur.push(`BT /${op.bold ? "F2" : "F1"} ${op.size} Tf ${MARGIN} ${y.toFixed(2)} Td (${esc(op.text)}) Tj ET`);
    }
    y -= h + (op.gap ?? 0);
  }
  newPage();
  if (!pages.length) pages.push([]);

  const footer = doc.footer ? esc(doc.footer) : "";
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };
  const fontN = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontB = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pagesN = objects.length + 1 + pages.length * 2; // reserve: after all page+content objects
  const pageNums: number[] = [];
  pages.forEach((lines, i) => {
    const content = [...lines, `BT /F1 8 Tf ${MARGIN} ${(MARGIN - 20).toFixed(2)} Td (${footer ? footer + "  ·  " : ""}Page ${i + 1} of ${pages.length}) Tj ET`].join("\n");
    const contentN = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    const pageN = add(`<< /Type /Page /Parent ${pagesN} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontN} 0 R /F2 ${fontB} 0 R >> >> /Contents ${contentN} 0 R >>`);
    pageNums.push(pageN);
  });
  const realPagesN = add(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`);
  if (realPagesN !== pagesN) {
    // Fix up parent references if the reservation guess was off.
    for (const n of pageNums) objects[n - 1] = objects[n - 1]!.replace(`/Parent ${pagesN} 0 R`, `/Parent ${realPagesN} 0 R`);
  }
  const catalogN = add(`<< /Type /Catalog /Pages ${realPagesN} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogN} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
