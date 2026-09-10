import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChatChannel, type ChatMessage } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { getSocket } from "../lib/socket.js";
import { ChatActions } from "../components/ChatActions.js";
import { cn } from "../lib/utils.js";

/** DMs have no name of their own — they're labelled with the *other* member. */
function channelLabel(c: ChatChannel, meId: string) {
  if (c.type === "dm") {
    const other = c.members.find((m) => m.id !== meId) ?? c.members[0];
    return other?.name ?? "Direct message";
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

  const dmChannels = channels.filter((c) => c.type === "dm");
  const namedChannels = channels.filter((c) => c.type === "channel");

  return (
    <div className="flex h-screen flex-1 overflow-hidden">
      {/* Channel list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-border bg-[#fbfbfa]">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">Chat</div>
        <ChatActions onOpen={(id) => navigate({ to: "/chat/$channelId", params: { channelId: id } })} />
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <Section title="Channels" />
          {namedChannels.map((c) => (
            <ChannelRow key={c.id} c={c} active={c.id === channelId} label={`# ${channelLabel(c, meId)}`} />
          ))}
          <Section title="Direct Messages" />
          {dmChannels.map((c) => (
            <ChannelRow key={c.id} c={c} active={c.id === channelId} label={channelLabel(c, meId)} dm />
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
}: {
  c: ChatChannel;
  active: boolean;
  label: string;
  dm?: boolean;
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
      {dm && (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-medium text-indigo-700">
          {label[0]}
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
      ? (channel.members.find((m) => m.id !== meId)?.name ?? "Direct message")
      : `# ${channel?.name ?? ""}`;

  return (
    <div className="flex flex-1 flex-col bg-white">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <span className="text-sm font-semibold">{title}</span>
        {channel?.topic && (
          <span className="text-xs text-muted-foreground">— {channel.topic}</span>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
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
