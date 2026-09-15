/** Row 126: RFC-4180 CSV → rows of objects keyed by header. Handles quotes, escaped quotes, CRLF and a BOM. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const src = text.replace(/^\ufeff/, "");
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* swallow; \n ends the row */ }
    else if (c === "\n") { row.push(field); records.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); records.push(row); }
  const headers = (records.shift() ?? []).map((h) => h.trim());
  const rows = records
    .filter((r) => r.some((v) => v.trim() !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { headers, rows };
}
