import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type NoteEntity } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { Avatar } from "./ui.js";
import { relativeTime } from "./TaskCollaboration.js";
import { cn } from "../lib/utils.js";

/** Notes attached to a company, contact or deal. Pinned ones float to the top. */
export function NotesPanel({ entityType, entityId }: { entityType: NoteEntity; entityId: string }) {
  const qc = useQueryClient();
  const { user, role } = useAuth();
  const isAdmin = role === "owner" || role === "admin";
  const [draft, setDraft] = useState("");

  const key = ["crm-notes", entityType, entityId];
  const { data: notes = [] } = useQuery({ queryKey: key, queryFn: () => api.getNotes(entityType, entityId) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const add = useMutation({
    mutationFn: () => api.addNote(entityType, entityId, draft.trim()),
    onSuccess: () => {
      setDraft("");
      refresh();
    },
  });
  const pin = useMutation({ mutationFn: api.pinNote, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteNote, onSuccess: refresh });

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) add.mutate();
        }}
        className="mb-3"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note…"
          rows={2}
          className="w-full resize-none rounded-md border border-border p-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
        />
        <div className="mt-1.5 flex justify-end">
          <button
            type="submit"
            disabled={!draft.trim() || add.isPending}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            Add note
          </button>
        </div>
      </form>

      {notes.length ? (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li
              key={n.id}
              className={cn(
                "group rounded-md border p-3",
                n.pinned ? "border-amber-200 bg-amber-50/50" : "border-border bg-white",
              )}
            >
              <div className="mb-1 flex items-center gap-2">
                <Avatar user={{ ...n.author, email: "", role: "" }} size={20} />
                <span className="text-xs font-medium text-slate-700">{n.author.name}</span>
                <span className="text-xs text-muted-foreground">{relativeTime(n.createdAt)}</span>
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
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      )}
    </div>
  );
}
