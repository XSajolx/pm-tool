import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type NoteEntity, type NoteKind } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { Avatar } from "./ui.js";
import { relativeTime } from "./TaskCollaboration.js";
import { cn } from "../lib/utils.js";

const KIND: Record<NoteKind, { icon: string; label: string }> = {
  note: { icon: "📝", label: "Note" },
  call: { icon: "📞", label: "Call" },
  meeting: { icon: "🤝", label: "Meeting" },
  email: { icon: "✉️", label: "Email" },
};
const KINDS = Object.keys(KIND) as NoteKind[];

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Row 54: the interaction log for a company, contact or deal — calls,
 * meetings, emails and notes with who, when and a summary. A company's log
 * also shows what was logged against its contacts and deals. Pinned entries
 * float to the top.
 */
export function NotesPanel({ entityType, entityId }: { entityType: NoteEntity; entityId: string }) {
  const qc = useQueryClient();
  const { user, role } = useAuth();
  const isAdmin = role === "owner" || role === "admin";
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<NoteKind>("note");
  const [date, setDate] = useState(todayIso());
  const [filter, setFilter] = useState<NoteKind | "all">("all");

  const key = ["crm-notes", entityType, entityId];
  const { data: notes = [] } = useQuery({ queryKey: key, queryFn: () => api.getNotes(entityType, entityId) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["crm-notes"] });
  };

  const add = useMutation({
    mutationFn: () => api.addNote(entityType, entityId, { body: draft.trim(), kind, occurredAt: date ? new Date(`${date}T12:00:00`).toISOString() : null }),
    onSuccess: () => {
      setDraft("");
      setKind("note");
      setDate(todayIso());
      refresh();
    },
  });
  const pin = useMutation({ mutationFn: api.pinNote, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteNote, onSuccess: refresh });

  const shown = filter === "all" ? notes : notes.filter((n) => n.kind === filter);
  const counts = KINDS.reduce((acc, k) => ({ ...acc, [k]: notes.filter((n) => n.kind === k).length }), {} as Record<NoteKind, number>);

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() && !add.isPending) add.mutate();
        }}
        className="mb-3 rounded-lg border border-border bg-white p-3"
      >
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn("rounded-full border px-2 py-0.5 text-xs transition", kind === k ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border text-slate-600 hover:bg-muted")}
            >
              {KIND[k].icon} {KIND[k].label}
            </button>
          ))}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="ml-auto rounded-md border border-border px-2 py-0.5 text-xs text-slate-700" title="When it happened" />
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={kind === "note" ? "Add a note…" : `Summary of the ${KIND[kind].label.toLowerCase()} — who, what was agreed, next step…`}
          rows={2}
          className="w-full resize-none rounded-md border border-border p-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Logged as {user?.name ?? "you"}</span>
          <button type="submit" disabled={!draft.trim() || add.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50">
            Log {KIND[kind].label.toLowerCase()}
          </button>
        </div>
      </form>

      {notes.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px]">
          <button type="button" onClick={() => setFilter("all")} className={cn("rounded-full px-2 py-0.5", filter === "all" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-muted")}>
            All {notes.length}
          </button>
          {KINDS.filter((k) => counts[k] > 0).map((k) => (
            <button key={k} type="button" onClick={() => setFilter(k)} className={cn("rounded-full px-2 py-0.5", filter === k ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-muted")}>
              {KIND[k].icon} {counts[k]}
            </button>
          ))}
        </div>
      )}

      {shown.length ? (
        <ul className="space-y-2">
          {shown.map((n) => (
            <li
              key={n.id}
              className={cn(
                "group rounded-md border p-3",
                n.pinned ? "border-amber-200 bg-amber-50/50" : "border-border bg-white",
              )}
            >
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-sm" title={KIND[n.kind].label}>{KIND[n.kind].icon}</span>
                <Avatar user={{ ...n.author, email: "", role: "" }} size={20} />
                <span className="text-xs font-medium text-slate-700">{n.author.name}</span>
                <span className="text-xs text-muted-foreground" title={new Date(n.occurredAt).toLocaleString()}>
                  {new Date(n.occurredAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(n.occurredAt).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined })}
                  {" · "}
                  {relativeTime(n.createdAt)}
                </span>
                {n.about && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-slate-600">
                    {n.about.type === "contact" ? "👤" : "💼"} {n.about.name}
                  </span>
                )}
                <span className="ml-auto flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={() => pin.mutate(n.id)}
                    title={n.pinned ? "Unpin" : "Pin"}
                    className={cn("rounded px-1 text-xs", n.pinned ? "text-amber-600" : "text-slate-400 hover:text-amber-600")}
                  >
                    📌
                  </button>
                  {(n.author.id === user?.id || isAdmin) && (
                    <button onClick={() => remove.mutate(n.id)} title="Delete" className="rounded px-1 text-xs text-slate-400 hover:text-red-500">
                      ✕
                    </button>
                  )}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{n.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{notes.length ? "Nothing of that kind yet." : "Nothing logged yet. Calls, meetings and emails go here."}</p>
      )}
    </div>
  );
}
