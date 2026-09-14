import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type EmploymentType, type WorkCalendar } from "../lib/api.js";
import { Avatar } from "./ui.js";
import { cn } from "../lib/utils.js";

/**
 * Row 110: the standard week, company holidays and closures, and each person's
 * own hours / working days. Timesheets, the team board, workload and reminders
 * all read expected hours from here.
 */
const DAYS = [
  { d: 1, label: "Mon" }, { d: 2, label: "Tue" }, { d: 3, label: "Wed" }, { d: 4, label: "Thu" }, { d: 5, label: "Fri" }, { d: 6, label: "Sat" }, { d: 0, label: "Sun" },
];
const TYPES: { id: EmploymentType; label: string }[] = [
  { id: "full_time", label: "Full-time" },
  { id: "part_time", label: "Part-time" },
  { id: "contractor", label: "Contractor" },
];

function DayPicker({ value, disabled, onChange }: { value: number[]; disabled?: boolean; onChange: (days: number[]) => void }) {
  return (
    <div className="flex gap-0.5">
      {DAYS.map(({ d, label }) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}
            className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", on ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200", "disabled:opacity-60")}
            aria-pressed={on}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function WorkCalendarSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["work-calendar"], queryFn: api.getWorkCalendar });
  const set = (next: WorkCalendar) => {
    qc.setQueryData(["work-calendar"], next);
    qc.invalidateQueries({ queryKey: ["timesheet"] });
    qc.invalidateQueries({ queryKey: ["workload"] });
    qc.invalidateQueries({ queryKey: ["members"] });
  };
  const save = useMutation({ mutationFn: (b: Parameters<typeof api.updateWorkCalendar>[0]) => api.updateWorkCalendar(b), onSuccess: set });
  const addHoliday = useMutation({ mutationFn: (b: Parameters<typeof api.addHoliday>[0]) => api.addHoliday(b), onSuccess: (n) => { set(n); setHName(""); setHDate(""); } });
  const removeHoliday = useMutation({ mutationFn: (id: string) => api.removeHoliday(id), onSuccess: set });
  const saveMember = useMutation({ mutationFn: ({ userId, ...b }: { userId: string } & Parameters<typeof api.updateMemberCalendar>[1]) => api.updateMemberCalendar(userId, b), onSuccess: set });
  const [hName, setHName] = useState("");
  const [hDate, setHDate] = useState("");
  const [hKind, setHKind] = useState<"holiday" | "closure">("holiday");
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const field = "rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-60";
  const err = (save.error ?? addHoliday.error ?? removeHoliday.error ?? saveMember.error) as Error | null;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = data.holidays.filter((h) => h.date.slice(0, 10) >= today);
  const past = data.holidays.filter((h) => h.date.slice(0, 10) < today);

  return (
    <div className="max-w-3xl" data-testid="work-calendar">
      <h1 className="text-lg font-semibold text-slate-900">Working hours & holidays</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Expected hours = a person's weekly hours spread over their working days, minus any company holiday or closure that lands on one of those days. Timesheets, the team board, workload and reminders all use the result.
      </p>

      <section className="mt-5 rounded-lg border border-border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Standard week</h2>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2 text-slate-700">
            <input type="number" min={0} max={168} defaultValue={data.standardWeeklyHours} disabled={!canEdit} onBlur={(e) => Number(e.target.value) !== data.standardWeeklyHours && save.mutate({ standardWeeklyHours: Number(e.target.value) })} className={`${field} w-20`} aria-label="Standard weekly hours" />
            hours per week for new people
          </label>
          <div className="flex items-center gap-2 text-slate-700">
            Working days <DayPicker value={data.workingDays} disabled={!canEdit} onChange={(days) => save.mutate({ workingDays: days })} />
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Company holidays & closures</h2>
        <ul className="mt-2 divide-y divide-border">
          {upcoming.length === 0 && <li className="py-2 text-sm text-muted-foreground">Nothing coming up.</li>}
          {upcoming.map((h) => (
            <li key={h.id} className="flex items-center gap-3 py-1.5 text-sm">
              <span className="w-28 tabular-nums text-slate-600">{new Date(h.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}</span>
              <span className="text-slate-800">{h.name}</span>
              <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", h.kind === "closure" ? "bg-amber-50 text-amber-700" : "bg-green-50 text-green-700")}>{h.kind}</span>
              {canEdit && <button type="button" onClick={() => removeHoliday.mutate(h.id)} className="ml-auto text-xs text-slate-400 hover:text-red-600">Remove</button>}
            </li>
          ))}
        </ul>
        {past.length > 0 && <p className="mt-1 text-[11px] text-muted-foreground">{past.length} past {past.length === 1 ? "day" : "days"} kept for old timesheets.</p>}
        {canEdit && (
          <form onSubmit={(e) => { e.preventDefault(); if (hDate && hName.trim()) addHoliday.mutate({ date: `${hDate}T00:00:00.000Z`, name: hName.trim(), kind: hKind }); }} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="date" value={hDate} onChange={(e) => setHDate(e.target.value)} className={field} aria-label="Holiday date" />
            <input value={hName} onChange={(e) => setHName(e.target.value)} placeholder="Name, e.g. Victory Day" className={`${field} w-56`} />
            <select value={hKind} onChange={(e) => setHKind(e.target.value as "holiday" | "closure")} className={field} aria-label="Kind">
              <option value="holiday">Public holiday</option>
              <option value="closure">Company closure</option>
            </select>
            <button type="submit" disabled={!hDate || !hName.trim() || addHoliday.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Add day off</button>
          </form>
        )}
      </section>

      <section className="mt-4 rounded-lg border border-border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">People</h2>
        <p className="text-xs text-muted-foreground">Part-timers and contractors get their own hours and days; everyone else follows the standard week.</p>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="pb-1 font-medium">Person</th>
              <th className="pb-1 font-medium">Type</th>
              <th className="pb-1 font-medium">Hours / week</th>
              <th className="pb-1 font-medium">Working days</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.userId} className="border-t border-border">
                <td className="py-1.5 pr-2">
                  <span className="inline-flex items-center gap-2">
                    <Avatar user={{ id: m.userId, name: m.name, avatarUrl: m.avatarUrl, email: "", role: m.role }} size={20} />
                    {m.name}
                  </span>
                </td>
                <td className="py-1.5 pr-2">
                  <select value={m.employmentType} disabled={!canEdit} onChange={(e) => saveMember.mutate({ userId: m.userId, employmentType: e.target.value as EmploymentType })} className={`${field} py-1 text-xs`} aria-label={`${m.name} employment type`}>
                    {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </td>
                <td className="py-1.5 pr-2">
                  <input type="number" min={0} max={168} key={`${m.userId}-${m.weeklyCapacityHours}`} defaultValue={m.weeklyCapacityHours} disabled={!canEdit} onBlur={(e) => Number(e.target.value) !== m.weeklyCapacityHours && saveMember.mutate({ userId: m.userId, weeklyCapacityHours: Number(e.target.value) })} className={`${field} w-20 py-1 text-xs`} aria-label={`${m.name} weekly hours`} />
                </td>
                <td className="py-1.5">
                  <div className="flex items-center gap-2">
                    <DayPicker value={m.workingDays ?? data.workingDays} disabled={!canEdit} onChange={(days) => saveMember.mutate({ userId: m.userId, workingDays: days })} />
                    {m.workingDays ? (
                      canEdit && <button type="button" onClick={() => saveMember.mutate({ userId: m.userId, workingDays: null })} className="text-[11px] text-muted-foreground hover:text-slate-700" title="Follow the standard week">reset</button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">standard</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {err && <p className="mt-2 text-xs text-red-600">{err.message}</p>}
    </div>
  );
}
