import { ASSIGNABLE_ROLES, ROLE_LABELS } from "../lib/roles.js";
import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { cn } from "../lib/utils.js";
import { useEscape } from "../lib/useEscape.js";

const COLORS = ["#6366f1", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];
const input =
  "w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

/** Creates a space (with default statuses and a first list) and jumps into it. */
export function NewSpaceDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]!);

  const create = useMutation({
    mutationFn: () => api.createSpace({ name: name.trim(), color }),
    onSuccess: (space) => {
      qc.invalidateQueries({ queryKey: ["spaces"] });
      onClose();
      navigate({ to: "/l/$listId", params: { listId: space.firstListId } });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <Dialog onClose={onClose} title="New space" subtitle="Comes with default statuses and a first list called Tasks.">
      <form onSubmit={submit} className="space-y-3">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing" required className={input} />
        <div className="flex gap-1.5">
          {COLORS.map((c) => (
            <button type="button" key={c} onClick={() => setColor(c)} className={cn("h-6 w-6 rounded-full border-2 transition", color === c ? "border-slate-800" : "border-transparent")} style={{ background: c }} />
          ))}
        </div>
        <Footer onClose={onClose} busy={create.isPending} disabled={!name.trim()} label="Create space" />
      </form>
    </Dialog>
  );
}

/**
 * Invite by email. No email is sent: the person is added now with a placeholder
 * account, and the first sign-in with that address claims it. The dialog
 * explains that so the inviter knows to pass the link on themselves.
 */
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "guest">("member");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: () => api.inviteMember({ email: email.trim(), name: name.trim() || undefined, role }),
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ["members"] });
      setDone(m.email);
      setEmail("");
      setName("");
    },
    onError: (e) => setError((e as Error).message),
  });
  const setMemberRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: "admin" | "member" | "guest" }) => api.setMemberRole(userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
  });
  const remove = useMutation({
    mutationFn: api.removeMember,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    if (email.trim()) invite.mutate();
  }

  return (
    <Dialog onClose={onClose} title="People" subtitle="Invite teammates and manage roles.">
      <form onSubmit={submit} className="space-y-2">
        <div className="grid grid-cols-[1fr_1fr_110px] gap-2">
          <input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@company.com" required className={input} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={input} />
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className={input}>
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={!email.trim() || invite.isPending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {invite.isPending ? "Adding…" : "Add to workspace"}
          </button>
          {done && <span className="text-xs text-emerald-700">Added {done}. Send them the sign-up link — the account links up when they sign in with that email.</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </form>

      <ul className="mt-4 max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">
              {m.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-slate-800">
                {m.name}
                {m.pending && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Invited</span>}
              </p>
              <p className="truncate text-xs text-muted-foreground">{m.email}</p>
            </div>
            {m.role === "owner" ? (
              <span className="text-xs text-muted-foreground">{ROLE_LABELS.owner}</span>
            ) : (
              <>
                <select
                  value={m.role}
                  onChange={(e) => setMemberRole.mutate({ userId: m.id, role: e.target.value as "admin" | "member" | "guest" })}
                  className="rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700"
                >
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
                <button onClick={() => remove.mutate(m.id)} title="Remove from workspace" className="text-slate-300 hover:text-red-500">✕</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function Dialog({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  useEscape(onClose);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </>
  );
}

function Footer({ onClose, busy, disabled, label }: { onClose: () => void; busy: boolean; disabled: boolean; label: string }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-muted">Cancel</button>
      <button type="submit" disabled={disabled || busy} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
        {busy ? "Working…" : label}
      </button>
    </div>
  );
}
