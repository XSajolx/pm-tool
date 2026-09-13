import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { cn } from "../lib/utils.js";

type Mode = null | "channel" | "dm" | "browse";

/** The chat list's toolbar: new channel, new (group) direct message, browse channels. */
export function ChatActions({ onOpen }: { onOpen: (channelId: string) => void }) {
  const [mode, setMode] = useState<Mode>(null);
  return (
    <div className="border-b border-border px-2 py-1.5">
      <div className="flex gap-1">
        <Action label="＋ Channel" active={mode === "channel"} onClick={() => setMode(mode === "channel" ? null : "channel")} />
        <Action label="＋ Message" active={mode === "dm"} onClick={() => setMode(mode === "dm" ? null : "dm")} />
        <Action label="Browse" active={mode === "browse"} onClick={() => setMode(mode === "browse" ? null : "browse")} />
      </div>
      {mode === "channel" && <NewChannel onDone={(id) => { setMode(null); onOpen(id); }} />}
      {mode === "dm" && <NewDm onDone={(id) => { setMode(null); onOpen(id); }} />}
      {mode === "browse" && <Browse onDone={(id) => { setMode(null); onOpen(id); }} />}
    </div>
  );
}

function Action({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn("rounded-md px-2 py-1 text-xs font-medium transition", active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-muted")}
    >
      {label}
    </button>
  );
}

function Initials({ name }: { name: string }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-700">
      {name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
    </span>
  );
}

/** Checkbox list of workspace members (excluding me). */
export function PeoplePicker({ selected, onChange, exclude = [] }: { selected: Set<string>; onChange: (next: Set<string>) => void; exclude?: string[] }) {
  const { user } = useAuth();
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const skip = new Set([user?.id, ...exclude]);
  const others = members.filter((m) => !skip.has(m.id));
  if (!others.length) return <p className="px-2 py-1.5 text-xs text-muted-foreground">No one else in the workspace yet.</p>;
  return (
    <div className="max-h-40 overflow-y-auto">
      {others.map((m) => (
        <label key={m.id} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs text-slate-700 hover:bg-muted">
          <input
            type="checkbox"
            checked={selected.has(m.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(m.id);
              else next.delete(m.id);
              onChange(next);
            }}
            className="h-3 w-3 accent-indigo-600"
          />
          <Initials name={m.name} />
          <span className="truncate">{m.name}</span>
        </label>
      ))}
    </div>
  );
}

/** Row 39: a named channel, public (anyone can browse + join) or private (invite-only). */
function NewChannel({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [people, setPeople] = useState<Set<string>>(new Set());
  const create = useMutation({
    mutationFn: () => api.createChannel({ name: name.trim().replace(/^#/, ""), isPrivate, memberIds: [...people] }),
    onSuccess: (ch) => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      onDone(ch.id);
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate();
  }
  return (
    <form onSubmit={submit} className="mt-1.5 space-y-1.5">
      <div className="flex gap-1">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="channel-name" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-xs outline-none focus:border-indigo-500" />
        <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">Create</button>
      </div>
      <label className="flex cursor-pointer items-center gap-1.5 px-1 text-xs text-slate-600">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} className="h-3 w-3 accent-indigo-600" />
        🔒 Private — invite only, hidden from Browse
      </label>
      <div className="rounded-md border border-border bg-white py-1">
        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Add people {people.size ? `(${people.size})` : ""}</p>
        <PeoplePicker selected={people} onChange={setPeople} />
      </div>
    </form>
  );
}

/** Row 39: pick one person for a 1:1, or several for a group message. */
function NewDm({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [people, setPeople] = useState<Set<string>>(new Set());
  const open = useMutation({
    mutationFn: (ids: string[]) => (ids.length === 1 ? api.openDm(ids[0]!) : api.openGroupDm(ids)),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      setPeople(new Set());
      onDone(r.id);
    },
  });
  return (
    <div className="mt-1.5 rounded-md border border-border bg-white py-1">
      <PeoplePicker selected={people} onChange={setPeople} />
      <div className="flex items-center justify-between border-t border-border px-2 pt-1.5">
        <span className="text-[10px] text-muted-foreground">{people.size > 1 ? "Group message" : people.size === 1 ? "Direct message" : "Pick people"}</span>
        <button
          type="button"
          disabled={!people.size || open.isPending}
          onClick={() => open.mutate([...people])}
          className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {open.isPending ? "Opening…" : `Message${people.size > 1 ? ` ${people.size} people` : ""}`}
        </button>
      </div>
    </div>
  );
}

function Browse({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const { data: all = [] } = useQuery({ queryKey: ["channels", "browse"], queryFn: api.browseChannels });
  const join = useMutation({
    mutationFn: (id: string) => api.joinChannel(id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      onDone(r.id);
    },
  });
  return (
    <div className="mt-1.5 max-h-48 overflow-y-auto rounded-md border border-border bg-white py-1">
      {all.length ? (
        all.map((c) => (
          <div key={c.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate text-slate-700">
              {c.isPrivate ? "🔒" : "#"} {c.name}
            </span>
            <span className="text-[10px] text-muted-foreground">{c.memberCount}</span>
            {c.joined ? (
              <button onClick={() => onDone(c.id)} className="text-indigo-600">Open</button>
            ) : (
              <button onClick={() => join.mutate(c.id)} className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-medium text-white">Join</button>
            )}
          </div>
        ))
      ) : (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">No channels yet.</p>
      )}
    </div>
  );
}
