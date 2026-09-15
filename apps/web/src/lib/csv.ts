/**
 * Row 127: turn what is on screen into a CSV and hand it to the browser.
 * RFC-4180 quoting, UTF-8 with BOM so Excel reads accents, ISO dates.
 */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x && "name" in x ? String((x as { name: unknown }).name) : String(x))).join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => cell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => cell(c.value(r))).join(","));
  return "\ufeff" + [head, ...body].join("\r\n") + "\r\n";
}

export function downloadCsv<T>(filename: string, rows: T[], columns: CsvColumn<T>[]) {
  const blob = new Blob([toCsv(rows, columns)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename.endsWith(".csv") ? filename : `${filename}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function csvStamp() {
  return new Date().toISOString().slice(0, 10);
}
