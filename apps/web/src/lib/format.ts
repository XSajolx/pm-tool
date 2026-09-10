/** 5400 → "1h 30m"; 0 → "0m". Minutes only, never seconds — this is for reports. */
export function fmtDuration(seconds: number) {
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** 5400 → "01:30:00", for the live timer. */
export function fmtClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

/** 1.5 → "1.5h"; 8 → "8h". Trailing zeros dropped. */
export function fmtHours(hours: number) {
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded}h`;
}

export function fmtMoney(amount: number, currency = "USD") {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** "Sep 8" */
export function fmtShortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Mon 8" */
export function fmtDayLabel(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

/** YYYY-MM-DD in UTC, the shape date inputs and the timesheet API expect. */
export function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}
