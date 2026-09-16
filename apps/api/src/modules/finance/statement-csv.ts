/**
 * Row 160: turn a bank / card statement CSV into candidate expenses.
 *
 * Banks disagree on everything, so the parser sniffs the header row for the
 * usual column names (date, description/payee/merchant, amount OR debit +
 * credit, currency, reference) and copes with quoted fields, either delimiter,
 * a few date formats and "(12.34)" / "-12.34" / "12.34 CR" style amounts.
 */
export interface ParsedRow {
  line: number;
  date: string | null;
  vendor: string;
  description: string;
  amount: number;
  kind: "expense" | "refund";
  currency: string | null;
  reference: string | null;
  problems: string[];
}

export interface ParseResult {
  columns: { date: string | null; description: string | null; amount: string | null; debit: string | null; credit: string | null; currency: string | null; reference: string | null; vendor: string | null };
  delimiter: string;
  rows: ParsedRow[];
  headerless: boolean;
}

const DATE_KEYS = ["date", "transaction date", "posted date", "posting date", "trans date", "booking date", "value date", "datum"];
const DESC_KEYS = ["description", "memo", "narrative", "details", "transaction", "transaction description", "name", "payee", "merchant", "merchant name", "counterparty", "particulars"];
const VENDOR_KEYS = ["payee", "merchant", "merchant name", "counterparty", "name", "vendor"];
const AMOUNT_KEYS = ["amount", "transaction amount", "amount (usd)", "amount usd", "value", "sum", "total"];
const DEBIT_KEYS = ["debit", "debit amount", "withdrawal", "withdrawals", "money out", "out", "paid out", "charge"];
const CREDIT_KEYS = ["credit", "credit amount", "deposit", "deposits", "money in", "in", "paid in", "payment"];
const CURRENCY_KEYS = ["currency", "ccy", "cur"];
const REF_KEYS = ["reference", "ref", "transaction id", "id", "cheque number", "check number", "fitid"];

export function parseStatement(text: string, maxRows = 5000): ParseResult {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim().length);
  const delimiter = sniffDelimiter(lines.slice(0, 5));
  const table = lines.map((l) => splitLine(l, delimiter));
  const header = table[0]?.map((h) => h.trim().toLowerCase().replace(/^"|"$/g, "")) ?? [];
  const find = (keys: string[]) => {
    const i = header.findIndex((h) => keys.includes(h));
    return i >= 0 ? i : header.findIndex((h) => keys.some((k) => h.includes(k)));
  };
  let dateIx = find(DATE_KEYS);
  let descIx = find(DESC_KEYS);
  const vendorIx = find(VENDOR_KEYS);
  let amountIx = find(AMOUNT_KEYS);
  const debitIx = find(DEBIT_KEYS);
  const creditIx = find(CREDIT_KEYS);
  const currencyIx = find(CURRENCY_KEYS);
  const refIx = find(REF_KEYS);
  const headerless = dateIx < 0 && amountIx < 0 && debitIx < 0;
  let body = table.slice(1);
  if (headerless) {
    // No recognisable header: assume date, description, amount in the first three columns.
    body = table;
    dateIx = 0;
    descIx = 1;
    amountIx = 2;
  }

  const rows: ParsedRow[] = [];
  body.slice(0, maxRows).forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return;
    const problems: string[] = [];
    const rawDate = dateIx >= 0 ? cells[dateIx] ?? "" : "";
    const date = parseDate(rawDate);
    if (!date) problems.push(`Unreadable date "${rawDate}"`);
    const description = (descIx >= 0 ? cells[descIx] : "")?.trim() ?? "";
    const vendorRaw = (vendorIx >= 0 && vendorIx !== descIx ? cells[vendorIx] : "")?.trim() ?? "";
    const vendor = cleanVendor(vendorRaw || description);
    let amount = 0;
    let kind: "expense" | "refund" = "expense";
    if (debitIx >= 0 || creditIx >= 0) {
      const d = debitIx >= 0 ? parseAmount(cells[debitIx] ?? "") : null;
      const c = creditIx >= 0 ? parseAmount(cells[creditIx] ?? "") : null;
      if (d && Math.abs(d) > 0) {
        amount = Math.abs(d);
        kind = "expense";
      } else if (c && Math.abs(c) > 0) {
        amount = Math.abs(c);
        kind = "refund";
      } else problems.push("No amount");
    } else {
      const a = amountIx >= 0 ? parseAmount(cells[amountIx] ?? "") : null;
      if (a === null || a === 0) problems.push("No amount");
      else {
        // Most exports show money out as negative; "CR" suffix or positive = money in.
        amount = Math.abs(a);
        kind = a < 0 || /\bDR\b/i.test(cells[amountIx] ?? "") ? "expense" : "refund";
      }
    }
    if (!vendor) problems.push("No description");
    rows.push({
      line: i + (headerless ? 1 : 2),
      date,
      vendor: vendor.slice(0, 255),
      description: description.slice(0, 2000),
      amount: Math.round(amount * 100) / 100,
      kind,
      currency: currencyIx >= 0 ? (cells[currencyIx] ?? "").trim().toUpperCase().slice(0, 3) || null : null,
      reference: refIx >= 0 ? (cells[refIx] ?? "").trim().slice(0, 255) || null : null,
      problems,
    });
  });

  return {
    columns: {
      date: dateIx >= 0 ? header[dateIx] ?? null : null,
      description: descIx >= 0 ? header[descIx] ?? null : null,
      vendor: vendorIx >= 0 ? header[vendorIx] ?? null : null,
      amount: amountIx >= 0 ? header[amountIx] ?? null : null,
      debit: debitIx >= 0 ? header[debitIx] ?? null : null,
      credit: creditIx >= 0 ? header[creditIx] ?? null : null,
      currency: currencyIx >= 0 ? header[currencyIx] ?? null : null,
      reference: refIx >= 0 ? header[refIx] ?? null : null,
    },
    delimiter,
    rows,
    headerless,
  };
}

function sniffDelimiter(sample: string[]) {
  const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  for (const l of sample) for (const d of Object.keys(counts) as (keyof typeof counts)[]) counts[d] += l.split(d).length - 1;
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",") as string;
}

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Accepts 2026-09-16, 16/09/2026, 09/16/2026 (US when the first field > 12 can't be a month), 16.09.2026, 16 Sep 2026, Sep 16, 2026. */
export function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/^"|"$/g, "");
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    // Ambiguous d/m vs m/d: prefer day-first unless that is impossible.
    if (a > 12 && b <= 12) return iso(y, b, a);
    if (b > 12 && a <= 12) return iso(y, a, b);
    return s.includes("/") ? iso(y, a, b) : iso(y, b, a);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function iso(y: number, mo: number, d: number) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/^"|"$/g, "");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\bCR\b/i.test(s)) sign = 1;
  else if (/\bDR\b/i.test(s)) sign = -1;
  s = s.replace(/[A-Za-z$€£¥\s]/g, "");
  if (s.startsWith("-")) {
    sign = -sign === 1 ? -1 : -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  // 1.234,56 vs 1,234.56
  if (/,\d{2}$/.test(s) && !/\.\d{2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

/** "AMZN Mktp US*2K3 ..." → "AMZN Mktp US"; strips card noise and trailing ids. */
export function cleanVendor(s: string) {
  return s
    .replace(/\s+/g, " ")
    .replace(/^(POS|CARD PURCHASE|PURCHASE|DEBIT CARD|VISA|MASTERCARD|PAYMENT TO|DIRECT DEBIT|DD|SEPA|TFR|TRANSFER TO)\s+/i, "")
    .replace(/[*#]\s*[A-Z0-9]{3,}.*$/i, "")
    .replace(/\s+\d{2}\/\d{2}(\/\d{2,4})?$/, "")
    .replace(/\s+[A-Z]{2}\s*$/, "")
    .trim();
}
