import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChatChannel, type ChatMessage } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { getSocket } from "../lib/socket.js";
import { ChatActions, PeoplePicker } from "../components/ChatActions.js";
import { cn } from "../lib/utils.js";

/**
 * DMs have no name of their own — they're labelled with the *other* members:
 * one person's full name, or first names for a group (row 39).
 */
function channelLabel(c: ChatChannel, meId: string) {
  if (c.type === "dm") {
    const others = c.members.filter((m) => m.id !== meId);
    if (!others.length) return c.members[0]?.name ?? "Direct message";
    if (others.length === 1) return others[0]!.name;
    return others.map((m) => m.name.split(" ")[0]).join(", ");
  }
  return c.name ?? "channel";
}

export function ChatPage() {
  const { channelId } = useParams({ strict: false }) as { channelId?: string };
  const navigate = useNavigate();
  const meId = useAuth().user!.id;
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: api.getChannels });

  // Auto-select the first channel when none is chosen.
  useEffect(() => {
    if (!channelId && channels[0]) {
      navigate({ to: "/chat/$channelId", params: { channelId: channels[0].id } });
    }
  }, [channelId, channels, navigate]);

  const projectChannels = channels.filter((c) => c.type === "channel" && c.projectId && !c.project?.archived);
  const namedChannels = channels.filter((c) => c.type === "channel" && !c.projectId);
  const dmChannels = channels.filter((c) => c.type === "dm");

  return (
    <div className="flex h-screen flex-1 overflow-hidden">
      {/* Channel list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-border bg-[#fbfbfa]">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">Chat</div>
        <ChatActions onOpen={(id) => navigate({ to: "/chat/$channelId", params: { channelId: id } })} />
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {projectChannels.length > 0 && (
            <>
              <Section title="Projects" />
              {projectChannels.map((c) => (
                <ChannelRow key={c.id} c={c} active={c.id === channelId} label={c.name ?? "project"} dot={c.project?.color} />
              ))}
            </>
          )}
          <Section title="Channels" />
          {namedChannels.map((c) => (
            <ChannelRow key={c.id} c={c} active={c.id === channelId} label={`${c.isPrivate ? "🔒" : "#"} ${channelLabel(c, meId)}`} />
          ))}
          {namedChannels.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No channels yet — create or browse one above.</p>}
          <Section title="Direct Messages" />
          {dmChannels.map((c) => (
            <ChannelRow key={c.id} c={c} active={c.id === channelId} label={channelLabel(c, meId)} dm group={c.members.length > 2} />
          ))}
        </div>
      </div>

      {/* Messages */}
      {channelId ? (
        <MessagePane
          channelId={channelId}
          channel={channels.find((c) => c.id === channelId)}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Select a channel
        </div>
      )}
    </div>
  );
}

function Section({ title }: { title: string }) {
  return (
    <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {title}
    </div>
  );
}

function ChannelRow({
  c,
  active,
  label,
  dm,
  group,
  dot,
}: {
  c: ChatChannel;
  active: boolean;
  label: string;
  dm?: boolean;
  group?: boolean;
  dot?: string;
}) {
  return (
    <Link
      to="/chat/$channelId"
      params={{ channelId: c.id }}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition",
        active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-muted",
      )}
    >
      {dot && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: dot }} />}
      {dm && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-medium text-indigo-700">
          {group ? c.members.length - 1 : label[0]}
        </span>
      )}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function MessagePane({ channelId, channel }: { channelId: string; channel?: ChatChannel }) {
  const qc = useQueryClient();
  const meId = useAuth().user!.id;
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", channelId],
    queryFn: () => api.getMessages(channelId),
  });

  // Join the channel room and listen for live messages.
  useEffect(() => {
    const socket = getSocket();
    socket.emit("join", channelId);
    const onNew = (msg: ChatMessage) => {
      if (msg.channelId !== channelId) return;
      qc.setQueryData<ChatMessage[]>(["messages", channelId], (old = []) =>
        old.some((m) => m.id === msg.id) ? old : [...old, msg],
      );
    };
    socket.on("message:new", onNew);
    return () => {
      socket.emit("leave", channelId);
      socket.off("message:new", onNew);
    };
  }, [channelId, qc]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = useMutation({
    mutationFn: (body: string) => api.sendMessage(channelId, body),
    onSuccess: () => setDraft(""),
  });

  const title =
    channel?.type === "dm"
      ? channelLabel(channel, meId)
      : `${channel?.isPrivate && !channel.projectId ? "🔒" : "#"} ${channel?.name ?? ""}`;

  return (
    <div className="flex flex-1 flex-col bg-white">
      <ChannelHeader channel={channel} title={title} />

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <p className="pt-6 text-center text-sm text-muted-foreground">
            {channel?.projectId ? "This is the project's channel. Everyone on the project team is here automatically." : "No messages yet. Say hello!"}
          </p>
        )}
        {messages.map((m, i) => {
          const mine = m.author.id === meId;
          const prev = messages[i - 1];
          const grouped = prev && prev.author.id === m.author.id;
          return (
            <div key={m.id} className={cn("flex gap-3", grouped && "mt-[-8px]")}>
              <div className="w-9 shrink-0">
                {!grouped && (
                  <span
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold text-white",
                      mine ? "bg-indigo-500" : "bg-slate-400",
                    )}
                  >
                    {m.author.name
                      .split(" ")
                      .map((p) => p[0])
                      .slice(0, 2)
                      .join("")}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                {!grouped && (
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-slate-800">{m.author.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(m.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                )}
                <p className="text-sm leading-relaxed text-slate-700">{m.body}</p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) send.mutate(draft.trim());
        }}
        className="border-t border-border p-3"
      >
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-500/30">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message ${title}`}
            className="flex-1 text-sm outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Row 39: title, topic, who's here, and the membership controls that make
 * sense for this kind of channel — invite/leave for named channels, a link to
 * the project team for project channels, nothing for DMs.
 */
function ChannelHeader({ channel, title }: { channel?: ChatChannel; title: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showMembers, setShowMembers] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [people, setPeople] = useState<Set<string>>(new Set());

  useEffect(() => {
    setShowMembers(false);
    setInviting(false);
    setPeople(new Set());
  }, [channel?.id]);

  const invite = useMutation({
    mutationFn: () => api.addChannelMembers(channel!.id, [...people]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      setInviting(false);
      setPeople(new Set());
    },
  });
  const leave = useMutation({
    mutationFn: () => api.leaveChannel(channel!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      navigate({ to: "/chat" });
    },
  });

  if (!channel) return <div className="border-b border-border px-5 py-3 text-sm font-semibold">{title}</div>;
  const isProject = Boolean(channel.projectId);
  const isDm = channel.type === "dm";

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-5 py-3">
        {channel.project && <span className="h-3 w-3 rounded-full" style={{ background: channel.project.color }} />}
        <span className="text-sm font-semibold">{title}</span>
        {channel.topic && <span className="text-xs text-muted-foreground">— {channel.topic}</span>}
        {isProject && channel.project && (
          <Link to="/projects/$projectId" params={{ projectId: channel.project.id }} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-slate-600 hover:text-indigo-700">
            Project · {channel.project.name}
          </Link>
        )}
        {channel.isPrivate && !isProject && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-slate-600">Private</span>}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setShowMembers((v) => !v)} className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-muted">
            👥 {channel.members.length}
          </button>
          {!isDm && !isProject && (
            <button type="button" onClick={() => { setInviting((v) => !v); setShowMembers(true); }} className="rounded-md px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50">
              + Add people
            </button>
          )}
          {!isDm && !isProject && (
            <button type="button" onClick={() => leave.mutate()} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-muted hover:text-red-600">
              Leave
            </button>
          )}
        </div>
      </div>
      {showMembers && (
        <div className="border-t border-border bg-[#fbfbfa] px-5 py-2 text-xs">
          <div className="flex flex-wrap gap-1.5">
            {channel.members.map((m) => (
              <span key={m.id} className="rounded-full border border-border bg-white px-2 py-0.5 text-slate-700">
                {m.name}
              </span>
            ))}
          </div>
          {isProject && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Members are managed from the project team — assigning someone a task in this project adds them here automatically.
            </p>
          )}
          {inviting && (
            <div className="mt-2 w-64 rounded-md border border-border bg-white py-1">
              <PeoplePicker selected={people} onChange={setPeople} exclude={channel.members.map((m) => m.id)} />
              <div className="flex justify-end border-t border-border px-2 pt-1.5">
                <button type="button" disabled={!people.size || invite.isPending} onClick={() => invite.mutate()} className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">
                  Add {people.size || ""}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
