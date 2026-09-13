/**
 * Natural-language parsing for quick-add (row 37). Recognises, anywhere in the
 * text: dates ("tomorrow", "fri", "next monday", "in 3 days", "sep 30",
 * "30/9", "2026-09-30"), priority ("!high", "!1"…"!4", "p1"…"p4"),
 * assignees ("@sakif") and tags ("#bug"). Whatever is recognised is removed
 * from the title.
 */
import type { Priority } from "./api.js";

export interface QuickParse {
  title: string;
  dueDate: string | null;
  dueLabel: string | null;
  priority: Priority | null;
  /** Raw @handles; the caller matches them against members. */
  assignees: string[];
  tags: string[];
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PRIORITY_WORDS: Record<string, Priority> = {
  urgent: "urgent",
  high: "high",
  normal: "normal",
  medium: "normal",
  low: "low",
  "1": "urgent",
  "2": "high",
  "3": "normal",
  "4": "low",
};

/** Local calendar day → ISO at UTC midnight (how due dates are stored). */
function dayIso(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}T00:00:00.000Z`;
}

function label(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function parseQuickAdd(input: string, now = new Date()): QuickParse {
  let text = ` ${input.trim()} `;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let due: Date | null = null;

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = text.match(re);
    if (m) {
      fn(m);
      text = text.replace(re, " ");
    }
  };

  // Relative words.
  take(/\s(today|tod)\s/i, () => (due = today));
  take(/\s(tomorrow|tmr|tmrw)\s/i, () => {
    due = new Date(today);
    due.setDate(due.getDate() + 1);
  });
  take(/\s(day after tomorrow)\s/i, () => {
    due = new Date(today);
    due.setDate(due.getDate() + 2);
  });
  take(/\snext week\s/i, () => {
    due = new Date(today);
    due.setDate(due.getDate() + ((8 - due.getDay()) % 7 || 7)); // next Monday
  });
  take(/\snext month\s/i, () => {
    due = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  });
  take(/\sin (\d{1,3}) ?(d|day|days|w|wk|week|weeks|mo|month|months)\s/i, (m) => {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    due = new Date(today);
    if (unit.startsWith("d")) due.setDate(due.getDate() + n);
    else if (unit.startsWith("w")) due.setDate(due.getDate() + 7 * n);
    else due.setMonth(due.getMonth() + n);
  });
  // Weekday, optionally with "next" / "this" / "on".
  take(/\s(?:(next|this|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\s/i, (m) => {
    const word = m[2]!.toLowerCase();
    let idx = WEEKDAYS.indexOf(word);
    if (idx < 0) idx = WEEKDAY_SHORT.findIndex((w) => word.startsWith(w));
    if (idx < 0) return;
    const d = new Date(today);
    let delta = (idx - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "fri" on a Friday means next Friday
    if ((m[1] ?? "").toLowerCase() === "next") delta += delta < 7 ? 7 : 0;
    d.setDate(d.getDate() + delta);
    due = d;
  });
  // ISO date.
  take(/\s(\d{4})-(\d{2})-(\d{2})\s/, (m) => {
    due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  });
  // "sep 30", "30 sep", "sept 30th".
  take(/\s(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s/i, (m) => {
    const month = MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3));
    due = nextOccurrence(today, month, Number(m[2]));
  });
  take(/\s(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s/i, (m) => {
    const month = MONTHS.indexOf(m[2]!.toLowerCase().slice(0, 3));
    due = nextOccurrence(today, month, Number(m[1]));
  });
  // "30/9" or "9/30" — read as day/month unless the first number can't be a day.
  take(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s/, (m) => {
    let a = Number(m[1]);
    let b = Number(m[2]);
    let day = a;
    let month = b - 1;
    if (a <= 12 && b > 12) {
      month = a - 1;
      day = b;
    }
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    due = year ? new Date(year, month, day) : nextOccurrence(today, month, day);
  });

  // Priority: "!high", "!1", "p2".
  let priority: Priority | null = null;
  take(/\s!(urgent|high|normal|medium|low|[1-4])\s/i, (m) => (priority = PRIORITY_WORDS[m[1]!.toLowerCase()] ?? null));
  if (!priority) take(/\sp([1-4])\s/i, (m) => (priority = PRIORITY_WORDS[m[1]!] ?? null));

  // Assignees and tags.
  const assignees: string[] = [];
  const tags: string[] = [];
  text = text.replace(/\s@([\w.-]+)/g, (_m, h: string) => {
    assignees.push(h.toLowerCase());
    return " ";
  });
  text = text.replace(/\s#([\w-]+)/g, (_m, t: string) => {
    tags.push(t);
    return " ";
  });

  const title = text.replace(/\s+/g, " ").trim();
  return {
    title,
    dueDate: due ? dayIso(due) : null,
    dueLabel: due ? label(due) : null,
    priority,
    assignees,
    tags,
  };
}

function nextOccurrence(today: Date, month: number, day: number) {
  let d = new Date(today.getFullYear(), month, day);
  if (d < today) d = new Date(today.getFullYear() + 1, month, day);
  return d;
}
