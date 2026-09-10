import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Meeting } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { isoDay } from "../lib/format.js";
import { CrmField, input } from "./CompaniesPage.js";
import { cn } from "../lib/utils.js";

/** Upcoming meetings for the next 30 days, grouped by day. */
export function MeetingsPage() {
  const qc = useQueryClient();
  const { user, role } = useAuth();
  const isAdmin = role === "owner" || role === "admin";
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);

  const { data: meetings = [], isLoading } = useQuery({
    queryKey: ["meetings", mine],
    queryFn: () => api.getMeetings({ mine }),
  });
  const cancel = useMutation({
    mutationFn: api.deleteMeeting,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["meetings"] }),
  });

  const days = useMemo(() => groupByDay(meetings), [meetings]);

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Meetings</h1>
        <span className="text-xs text-muted-foreground">Next 30 days</span>
        <label className="ml-3 flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="accent-indigo-600" />
          Only mine
        </label>
        <button onClick={() => setCreating(true)} className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700">
          New meeting
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : days.length ? (
          days.map((d) => (
            <section key={d.day} className="mb-5">
              <h3 className="mb-1.5 text-sm font-semibold text-slate-800">{d.label}</h3>
              <ul className="overflow-hidden rounded-lg border border-border bg-white">
                {d.items.map((m) => {
                  const canCancel = m.organizer.id === user?.id || isAdmin;
                  return (
                    <li key={m.id} className="group flex items-start gap-4 border-b border-border px-4 py-3 last:border-b-0">
                      <div className="w-24 shrink-0 text-sm tabular-nums text-slate-700">
                        {timeOf(m.startsAt)}
                        <span className="block text-xs text-muted-foreground">– {timeOf(m.endsAt)}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-800">{m.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {[m.company?.name, m.contact?.name, m.deal?.title, m.location].filter(Boolean).join(" · ") || "No details"}
                        </p>
                        <div className="mt-1.5 flex -space-x-1.5">
                          {m.attendees.map((a) => (
                            <span key={a.id} title={a.name} className="flex h-6 w-6 items-center justify-center rounded-full border border-white bg-indigo-100 text-[10px] font-semibold text-indigo-700">
                              {a.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                            </span>
                          ))}
                        </div>
                      </div>
                      {canCancel && (
                        <button onClick={() => cancel.mutate(m.id)} className="shrink-0 text-xs text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500">
                          Cancel
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl">📅</span>
            <p className="text-sm text-muted-foreground">{mine ? "Nothing on your calendar." : "No meetings scheduled."}</p>
          </div>
        )}
      </div>

      {creating && <NewMeetingDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewMeetingDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const { data: companies = [] } = useQuery({ queryKey: ["companies", ""], queryFn: () => api.getCompanies() });

  const [title, setTitle] = useState("");
  const [date, setDate] = useState(isoDay(new Date()));
  const [time, setTime] = useState("10:00");
  const [minutes, setMinutes] = useState("30");
  const [location, setLocation] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const startsAt = new Date(`${date}T${time}:00`);
      const endsAt = new Date(startsAt.getTime() + Number(minutes) * 60_000);
      return api.createMeeting({
        title: title.trim(),
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        location: location.trim() || null,
        companyId: companyId || null,
        attendeeIds: attendees,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meetings"] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) create.mutate();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <form onSubmit={submit} className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">New meeting</h2>
        <div className="mt-4 space-y-3">
          <CrmField label="Title"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required className={input} placeholder="Kickoff with Acme" /></CrmField>
          <div className="grid grid-cols-3 gap-3">
            <CrmField label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></CrmField>
            <CrmField label="Time"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} /></CrmField>
            <CrmField label="Minutes">
              <select value={minutes} onChange={(e) => setMinutes(e.target.value)} className={input}>
                {["15", "30", "45", "60", "90", "120"].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </CrmField>
          </div>
          <CrmField label="Location / link"><input value={location} onChange={(e) => setLocation(e.target.value)} className={input} placeholder="Meet link or room" /></CrmField>
          <CrmField label="Company">
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={input}>
              <option value="">—</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </CrmField>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-600">Attendees</span>
            <div className="flex flex-wrap gap-1.5">
              {members.filter((m) => m.id !== user?.id).map((m) => {
                const on = attendees.includes(m.id);
                return (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => setAttendees((a) => (on ? a.filter((x) => x !== m.id) : [...a, m.id]))}
                    className={cn("rounded-full border px-2.5 py-1 text-xs transition", on ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border text-slate-600 hover:bg-muted")}
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!title.trim() || create.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {create.isPending ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </form>
    </>
  );
}

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function groupByDay(meetings: Meeting[]) {
  const today = isoDay(new Date());
  const map = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const day = isoDay(new Date(m.startsAt));
    (map.get(day) ?? map.set(day, []).get(day)!).push(m);
  }
  return [...map.entries()].map(([day, items]) => ({
    day,
    label: day === today ? "Today" : new Date(day).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }),
    items,
  }));
}
