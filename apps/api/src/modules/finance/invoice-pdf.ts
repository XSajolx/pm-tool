/**
 * Row 156: the invoice as a PDF. Same dependency-free writer as the proposal
 * PDF, but laid out as a document with columns: brand band, bill-to block,
 * a line-item table with right-aligned numbers, totals, notes, footer.
 */
export interface InvoicePdfInput {
  number: string;
  title: string;
  status: string;
  issueDate: Date;
  dueDate: Date | null;
  currency: string;
  billTo: { company?: string | null; contact?: string | null; email?: string | null; address?: string | null };
  project?: string | null;
  items: { description: string; quantity: number; unitPrice: number; amount: number }[];
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  notes?: string | null;
  brand: { color: string; orgName: string; footer?: string | null };
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 50;
const LINE = 14;

function esc(s: string) {
  return s
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Rough Helvetica advance: ~0.52em per glyph. Good enough to right-align a number column. */
function width(s: string, size: number) {
  return s.length * size * 0.52;
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

function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1]!, 16) : 0x6366f1;
  return `${(((n >> 16) & 255) / 255).toFixed(3)} ${(((n >> 8) & 255) / 255).toFixed(3)} ${((n & 255) / 255).toFixed(3)}`;
}

function money(n: number, currency: string) {
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}${currency} ${s}`;
}

function day(d: Date | null) {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export function renderInvoicePdf(inv: InvoicePdfInput): Buffer {
  const rgb = hexToRgb(inv.brand.color);
  const DARK = "0.06 0.09 0.16 rg";
  const GREY = "0.42 0.46 0.52 rg";
  const pages: string[][] = [];
  let cur: string[] = [];
  let y = 0;

  const text = (x: number, yy: number, s: string, size: number, opts: { bold?: boolean; color?: string; right?: boolean } = {}) => {
    const xx = opts.right ? x - width(s, size) : x;
    cur.push(`${opts.color ?? DARK} BT /${opts.bold ? "F2" : "F1"} ${size} Tf ${xx.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
  };
  const rule = (yy: number, color = "0.85 0.87 0.9 rg") => cur.push(`${color} ${M} ${yy.toFixed(2)} ${(PAGE_W - 2 * M).toFixed(2)} 0.8 re f`);
  const newPage = (first: boolean) => {
    if (cur.length) pages.push(cur);
    cur = [];
    if (first) {
      const BAND = 96;
      cur.push(`${rgb} rg 0 ${(PAGE_H - BAND).toFixed(2)} ${PAGE_W} ${BAND} re f`);
      text(M, PAGE_H - 40, "INVOICE", 22, { bold: true, color: "1 1 1 rg" });
      text(M, PAGE_H - 60, inv.brand.orgName, 10, { color: "1 1 1 rg" });
      text(PAGE_W - M, PAGE_H - 40, inv.number, 14, { bold: true, color: "1 1 1 rg", right: true });
      const badge = inv.status === "paid" ? "PAID" : inv.status === "void" ? "VOID" : inv.dueDate && inv.dueDate < new Date() && inv.total - inv.amountPaid > 0.005 ? "OVERDUE" : inv.status === "draft" ? "DRAFT" : "DUE";
      text(PAGE_W - M, PAGE_H - 60, badge, 10, { bold: true, color: "1 1 1 rg", right: true });
      y = PAGE_H - BAND - 34;
    } else {
      y = PAGE_H - M;
    }
  };
  const ensure = (h: number) => {
    if (y - h < M + 30) newPage(false);
  };

  newPage(true);

  // Header blocks: bill-to on the left, dates on the right.
  const leftTop = y;
  text(M, y, "BILL TO", 8, { bold: true, color: GREY });
  y -= LINE;
  const billLines = [inv.billTo.company, inv.billTo.contact, inv.billTo.email, ...(inv.billTo.address ? inv.billTo.address.split("\n") : [])].filter((s): s is string => Boolean(s && s.trim()));
  if (!billLines.length) billLines.push("—");
  for (const l of billLines.slice(0, 6)) {
    text(M, y, l, 10, { bold: l === billLines[0] });
    y -= LINE;
  }
  if (inv.project) {
    y -= 4;
    text(M, y, "PROJECT", 8, { bold: true, color: GREY });
    y -= LINE;
    text(M, y, inv.project, 10);
    y -= LINE;
  }
  const leftBottom = y;

  let ry = leftTop;
  const kv = (k: string, v: string, bold = false) => {
    text(PAGE_W - M - 150, ry, k, 8, { bold: true, color: GREY });
    text(PAGE_W - M, ry, v, 10, { right: true, bold });
    ry -= LINE;
  };
  kv("ISSUED", day(inv.issueDate));
  kv("DUE", day(inv.dueDate));
  kv("TOTAL", money(inv.total, inv.currency), true);
  kv("BALANCE DUE", money(Math.max(0, inv.total - inv.amountPaid), inv.currency), true);

  y = Math.min(leftBottom, ry) - 10;
  text(M, y, inv.title, 13, { bold: true });
  y -= 22;

  // Items table.
  const colQty = PAGE_W - M - 230;
  const colUnit = PAGE_W - M - 120;
  const colAmt = PAGE_W - M;
  const header = () => {
    cur.push(`0.96 0.97 0.98 rg ${M} ${(y - 5).toFixed(2)} ${(PAGE_W - 2 * M).toFixed(2)} 18 re f`);
    text(M + 6, y, "DESCRIPTION", 8, { bold: true, color: GREY });
    text(colQty, y, "QTY", 8, { bold: true, color: GREY, right: true });
    text(colUnit, y, "UNIT PRICE", 8, { bold: true, color: GREY, right: true });
    text(colAmt - 6, y, "AMOUNT", 8, { bold: true, color: GREY, right: true });
    y -= 20;
  };
  header();
  for (const it of inv.items) {
    const lines = wrap(it.description || "—", 60);
    ensure(lines.length * LINE + 6);
    if (y > PAGE_H - M - 10 && cur.length < 3) header();
    let first = true;
    for (const l of lines) {
      text(M + 6, y, l, 10);
      if (first) {
        text(colQty, y, String(it.quantity), 10, { right: true });
        text(colUnit, y, money(it.unitPrice, inv.currency), 10, { right: true });
        text(colAmt - 6, y, money(it.amount, inv.currency), 10, { right: true });
        first = false;
      }
      y -= LINE;
    }
    y -= 4;
    rule(y + 8);
  }
  if (!inv.items.length) {
    text(M + 6, y, "No line items", 10, { color: GREY });
    y -= LINE;
  }

  // Totals block, right-aligned.
  ensure(6 * LINE + 20);
  y -= 6;
  const tk = (k: string, v: string, bold = false, size = 10) => {
    text(colUnit - 40, y, k, size, { color: bold ? DARK : GREY, bold });
    text(colAmt - 6, y, v, size, { right: true, bold });
    y -= LINE + (bold ? 2 : 0);
  };
  tk("Subtotal", money(inv.subtotal, inv.currency));
  if (inv.discountAmount > 0) tk(`Discount (${inv.discountPercent}%)`, money(-inv.discountAmount, inv.currency));
  if (inv.taxRate > 0 || inv.taxAmount > 0) tk(`Tax (${inv.taxRate}%)`, money(inv.taxAmount, inv.currency));
  rule(y + 9);
  tk("Total", money(inv.total, inv.currency), true, 11);
  if (inv.amountPaid > 0) {
    tk("Paid", money(-inv.amountPaid, inv.currency));
    tk("Balance due", money(Math.max(0, inv.total - inv.amountPaid), inv.currency), true, 11);
  }

  if (inv.notes?.trim()) {
    y -= 10;
    const lines = wrap(inv.notes, 95);
    ensure((lines.length + 1) * LINE);
    text(M, y, "NOTES", 8, { bold: true, color: GREY });
    y -= LINE;
    for (const l of lines) {
      ensure(LINE);
      text(M, y, l, 9.5);
      y -= LINE - 1;
    }
  }
  pages.push(cur);

  // Object writer.
  const footerText = inv.brand.footer?.trim();
  const footer = esc([footerText, footerText?.includes(inv.brand.orgName) ? null : inv.brand.orgName, inv.number].filter(Boolean).join("  ·  ").slice(0, 140));
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const fontN = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontB = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const contentNums = pages.map((lines, i) => {
    const content = [
      ...lines,
      `${rgb} rg ${M} ${(M - 14).toFixed(2)} ${PAGE_W - 2 * M} 1 re f`,
      `${GREY} BT /F1 8 Tf ${M} ${(M - 26).toFixed(2)} Td (${footer}) Tj ET`,
      `${GREY} BT /F1 8 Tf ${(PAGE_W - M - 60).toFixed(2)} ${(M - 26).toFixed(2)} Td (Page ${i + 1} of ${pages.length}) Tj ET`,
    ].join("\n");
    return add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  });
  const pagesN = objects.length + pages.length + 1;
  const pageNums = pages.map((_, i) =>
    add(`<< /Type /Page /Parent ${pagesN} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontN} 0 R /F2 ${fontB} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`),
  );
  const realPagesN = add(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`);
  if (realPagesN !== pagesN) for (const n of pageNums) objects[n - 1] = objects[n - 1]!.replace(`/Parent ${pagesN} 0 R`, `/Parent ${realPagesN} 0 R`);
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
