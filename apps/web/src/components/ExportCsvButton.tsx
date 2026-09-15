import { csvStamp, downloadCsv, type CsvColumn } from "../lib/csv.js";

/** Row 127: exports exactly the rows the caller is showing - filters, search and sort included. */
export function ExportCsvButton<T>({ rows, columns, filename, label = "Export CSV", className }: { rows: T[]; columns: CsvColumn<T>[]; filename: string; label?: string; className?: string }) {
  return (
    <button
      type="button"
      disabled={!rows.length}
      onClick={() => downloadCsv(`${filename}-${csvStamp()}`, rows, columns)}
      title={rows.length ? `Download ${rows.length} row${rows.length === 1 ? "" : "s"} as CSV (what's on screen)` : "Nothing to export"}
      className={className ?? "rounded-md border border-border bg-white px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-40"}
      data-testid="export-csv"
    >
      ⇩ {label}{rows.length ? ` (${rows.length})` : ""}
    </button>
  );
}
