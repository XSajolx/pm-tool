import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { cn } from "../lib/utils.js";

type Mode = null | "channel" | "dm" | "browse";

/** The chat list's toolbar: new channel, new direct message, browse channels. */
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

function NewChannel({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createChannel(name.trim().replace(/^#/, "")),
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
    <form onSubmit={submit} className="mt-1.5 flex gap-1">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="channel-name" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-xs outline-none focus:border-indigo-500" />
      <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">Create</button>
    </form>
  );
}

function NewDm({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: members = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const open = useMutation({
    mutationFn: (userId: string) => api.openDm(userId),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      onDone(r.id);
    },
  });
  const others = members.filter((m) => m.id !== user?.id);
  return (
    <div className="mt-1.5 max-h-48 overflow-y-auto rounded-md border border-border bg-white py-1">
      {others.length ? (
        others.map((m) => (
          <button key={m.id} onClick={() => open.mutate(m.id)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-muted">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-700">
              {m.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
            </span>
            {m.name}
          </button>
        ))
      ) : (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">No one else in the workspace yet.</p>
      )}
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
            <span className="min-w-0 flex-1 truncate text-slate-700"># {c.name}</span>
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
