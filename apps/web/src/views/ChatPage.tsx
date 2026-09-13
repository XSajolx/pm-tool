import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChatChannel, type ChatMember, type ChatMessage } from "../lib/api.js";
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
  const qc = useQueryClient();

  // Row 42: badges follow new messages and read marks from any device.
  useEffect(() => {
    const socket = getSocket();
    const changed = () => qc.invalidateQueries({ queryKey: ["channels"] });
    socket.on("chat:unread", changed);
    socket.on("chat:read", changed);
    return () => {
      socket.off("chat:unread", changed);
      socket.off("chat:read", changed);
    };
  }, [qc]);

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
      <span className={cn("truncate", !active && c.unreadCount > 0 && "font-semibold text-slate-900")}>{label}</span>
      {!active && c.unreadCount > 0 && (
        <span className="ml-auto min-w-[18px] rounded-full bg-indigo-600 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white" title={`${c.unreadCount} unread`}>
          {c.unreadCount > 99 ? "99+" : c.unreadCount}
        </span>
      )}
    </Link>
  );
}

function MessagePane({ channelId, channel }: { channelId: string; channel?: ChatChannel }) {
  const qc = useQueryClient();
  const meId = useAuth().user!.id;
  const [threadId, setThreadId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", channelId],
    queryFn: () => api.getMessages(channelId),
  });

  useEffect(() => setThreadId(null), [channelId]);

  // Row 42: remember where I'd read up to when I opened this channel, so the
  // "New messages" line stays put while I read, then mark everything read.
  const [marker, setMarker] = useState<{ channelId: string; at: string | null } | null>(null);
  useEffect(() => {
    if (channel && marker?.channelId !== channelId) setMarker({ channelId, at: channel.lastReadAt });
  }, [channel, channelId, marker]);

  const markRead = useMutation({
    mutationFn: () => api.markChannelRead(channelId),
    onSuccess: ({ lastReadAt }) =>
      qc.setQueryData<ChatChannel[]>(["channels"], (old = []) => old.map((c) => (c.id === channelId ? { ...c, unreadCount: 0, lastReadAt } : c))),
  });
  const lastAt = messages.at(-1)?.createdAt;
  useEffect(() => {
    if (!channel) return;
    const behind = channel.unreadCount > 0 || (lastAt && (!channel.lastReadAt || new Date(lastAt) > new Date(channel.lastReadAt)));
    if (behind && !markRead.isPending) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, lastAt, channel?.unreadCount]);

  const firstUnreadIdx =
    marker && marker.channelId === channelId
      ? messages.findIndex((m) => m.author.id !== meId && (!marker.at || new Date(m.createdAt) > new Date(marker.at)))
      : -1;

  // Join the channel room and listen for live messages. Replies (row 40) go
  // into their thread and bump the parent's count instead of the channel.
  useEffect(() => {
    const socket = getSocket();
    socket.emit("join", channelId);
    const onNew = (msg: ChatMessage) => {
      if (msg.channelId !== channelId) return;
      if (msg.parentMessageId) {
        const parentId = msg.parentMessageId;
        qc.setQueryData<ThreadData>(["thread", channelId, parentId], (old) =>
          old && !old.replies.some((r) => r.id === msg.id) ? { ...old, replies: [...old.replies, msg] } : old,
        );
        qc.setQueryData<ChatMessage[]>(["messages", channelId], (old = []) =>
          old.map((m) => (m.id === parentId ? { ...m, replyCount: (m.replyCount ?? 0) + 1, lastReplyAt: msg.createdAt } : m)),
        );
        return;
      }
      qc.setQueryData<ChatMessage[]>(["messages", channelId], (old = []) =>
        old.some((m) => m.id === msg.id) ? old : [...old, msg],
      );
    };
    socket.on("message:new", onNew);
    // After a reconnect (API restart, flaky network) the server has forgotten
    // our room, so join again or live messages silently stop.
    const rejoin = () => socket.emit("join", channelId);
    socket.on("connect", rejoin);
    return () => {
      socket.emit("leave", channelId);
      socket.off("message:new", onNew);
      socket.off("connect", rejoin);
    };
  }, [channelId, qc]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = useMutation({
    mutationFn: ({ body, ids }: { body: string; ids: string[] }) => api.sendMessage(channelId, body, undefined, ids),
    // The socket echoes it too; this just makes sure it shows even if the socket is down.
    onSuccess: (msg) => qc.setQueryData<ChatMessage[]>(["messages", channelId], (old = []) => (old.some((m) => m.id === msg.id) ? old : [...old, msg])),
  });
  const members = channel?.members ?? [];

  const title =
    channel?.type === "dm"
      ? channelLabel(channel, meId)
      : `${channel?.isPrivate && !channel.projectId ? "🔒" : "#"} ${channel?.name ?? ""}`;

  return (
    <div className="flex flex-1 overflow-hidden bg-white">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelHeader channel={channel} title={title} />

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {messages.length === 0 && (
            <p className="pt-6 text-center text-sm text-muted-foreground">
              {channel?.projectId ? "This is the project's channel. Everyone on the project team is here automatically." : "No messages yet. Say hello!"}
            </p>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const isFirstUnread = i === firstUnreadIdx;
            return (
              <div key={m.id}>
                {isFirstUnread && (
                  <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-red-500">
                    <span className="h-px flex-1 bg-red-300" />
                    New messages
                    <span className="h-px flex-1 bg-red-300" />
                  </div>
                )}
                <MessageRow
                  m={m}
                  meId={meId}
                  members={members}
                  grouped={Boolean(prev && prev.author.id === m.author.id && !prev.replyCount && !isFirstUnread)}
                  onReply={() => setThreadId(m.id)}
                  threadOpen={threadId === m.id}
                />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <MentionComposer members={members} placeholder={`Message ${title}`} pending={send.isPending} onSend={(body, ids) => send.mutate({ body, ids })} />
      </div>

      {threadId && <ThreadPane channelId={channelId} messageId={threadId} meId={meId} members={members} onClose={() => setThreadId(null)} />}
    </div>
  );
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * One message. Hovering shows "Reply" (row 40); a message that already has
 * replies shows the count as a link into its thread.
 */
function MessageRow({
  m,
  meId,
  members,
  grouped,
  onReply,
  threadOpen,
  compact,
}: {
  m: ChatMessage;
  meId: string;
  members: ChatMember[];
  grouped?: boolean;
  onReply?: () => void;
  threadOpen?: boolean;
  compact?: boolean;
}) {
  const mine = m.author.id === meId;
  const initials = m.author.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <div className={cn("group relative -mx-2 flex gap-3 rounded-md px-2 py-0.5 hover:bg-muted/40", grouped && "-mt-2", threadOpen && "bg-indigo-50/60")}>
      <div className={cn("shrink-0", compact ? "w-7" : "w-9")}>
        {!grouped && (
          <span
            className={cn(
              "flex items-center justify-center rounded-full font-semibold text-white",
              compact ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs",
              mine ? "bg-indigo-500" : "bg-slate-400",
            )}
          >
            {initials}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-slate-800">{m.author.name}</span>
            <span className="text-[11px] text-muted-foreground">{fmtTime(m.createdAt)}</span>
          </div>
        )}
        <MessageBody body={m.body} members={members} meId={meId} />
        {onReply && (m.replyCount ?? 0) > 0 && (
          <button type="button" onClick={onReply} className="mt-1 flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:underline">
            💬 {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
            {m.lastReplyAt && <span className="font-normal text-muted-foreground">· last {fmtTime(m.lastReplyAt)}</span>}
          </button>
        )}
      </div>
      {onReply && (
        <button
          type="button"
          onClick={onReply}
          title="Reply in thread"
          className="absolute right-2 top-0 hidden rounded-md border border-border bg-white px-1.5 py-0.5 text-[11px] text-slate-600 shadow-sm hover:text-indigo-700 group-hover:block"
        >
          💬 Reply
        </button>
      )}
    </div>
  );
}

type ThreadData = { root: ChatMessage; replies: ChatMessage[] };

/** Row 40: side panel with the original message and its replies. */
function ThreadPane({ channelId, messageId, meId, members, onClose }: { channelId: string; messageId: string; meId: string; members: ChatMember[]; onClose: () => void }) {
  const qc = useQueryClient();
  const endRef = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ["thread", channelId, messageId], queryFn: () => api.getThread(channelId, messageId) });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.replies.length]);

  const reply = useMutation({
    mutationFn: ({ body, ids }: { body: string; ids: string[] }) => api.sendMessage(channelId, body, messageId, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thread", channelId, messageId] });
      qc.invalidateQueries({ queryKey: ["messages", channelId] });
    },
  });

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-[#fbfbfa]">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">Thread</span>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-muted" aria-label="Close thread">
          ✕
        </button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {data ? (
          <>
            <MessageRow m={data.root} meId={meId} members={members} compact />
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {data.replies.length} {data.replies.length === 1 ? "reply" : "replies"}
              <span className="h-px flex-1 bg-border" />
            </div>
            {data.replies.map((r, i) => {
              const prev = data.replies[i - 1];
              return <MessageRow key={r.id} m={r} meId={meId} members={members} compact grouped={Boolean(prev && prev.author.id === r.author.id)} />;
            })}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        <div ref={endRef} />
      </div>
      <MentionComposer members={members} placeholder="Reply in thread…" buttonLabel="Reply" autoFocus pending={reply.isPending} onSend={(body, ids) => reply.mutate({ body, ids })} />
    </aside>
  );
}

/** The text after a trailing "@", lower-cased — or null when not mentioning. */
function mentionToken(text: string): string | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

type Suggestion = { id: string; name: string; hint: string; special: boolean };
const SPECIAL_MENTIONS: Suggestion[] = [
  { id: "channel", name: "channel", hint: "everyone here", special: true },
  { id: "here", name: "here", special: true, hint: "members online now" },
];

/**
 * Row 41: a one-line composer with an @mention picker. The picker lists only
 * people who can see this channel, plus @channel and @here. Enter/Tab picks,
 * arrows move, Escape dismisses. Picked ids ride along with the message so
 * the server doesn't have to guess from names.
 */
function MentionComposer({
  members,
  placeholder,
  onSend,
  pending,
  autoFocus,
  buttonLabel = "Send",
}: {
  members: ChatMember[];
  placeholder: string;
  onSend: (body: string, mentionedUserIds: string[]) => void;
  pending?: boolean;
  autoFocus?: boolean;
  buttonLabel?: string;
}) {
  const meId = useAuth().user!.id;
  const [draft, setDraft] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const token = mentionToken(draft);
  const suggestions: Suggestion[] =
    token === null || dismissed === token
      ? []
      : [
          ...members
            .filter((m) => m.id !== meId && m.name.toLowerCase().startsWith(token))
            .slice(0, 6)
            .map((m) => ({ id: m.id, name: m.name, hint: "", special: false })),
          ...SPECIAL_MENTIONS.filter((s) => s.name.startsWith(token)),
        ];
  useEffect(() => setCursor(0), [token]);

  function pick(s: Suggestion) {
    setDraft((d) => d.replace(/@[^\s@]*$/, `@${s.name} `));
    if (!s.special) setIds((v) => (v.includes(s.id) ? v : [...v, s.id]));
  }
  function submit() {
    const body = draft.trim();
    if (!body || pending) return;
    onSend(body, ids);
    setDraft("");
    setIds([]);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-border p-3"
    >
      <div className="relative">
        {suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-md border border-border bg-white py-1 shadow-lg">
            {suggestions.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault(); // keep the input focused
                  pick(s);
                }}
                className={cn("flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-muted", i === cursor && "bg-muted")}
              >
                <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold", s.special ? "bg-amber-100 text-amber-800" : "bg-indigo-100 text-indigo-700")}>
                  {s.special ? "@" : s.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                </span>
                <span>@{s.name}</span>
                {s.hint && <span className="ml-auto text-[10px] text-muted-foreground">{s.hint}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-500/30">
          <input
            autoFocus={autoFocus}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDismissed(null);
            }}
            onKeyDown={(e) => {
              if (!suggestions.length) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => (c + 1) % suggestions.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => (c - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                pick(suggestions[cursor] ?? suggestions[0]!);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(token);
              }
            }}
            placeholder={`${placeholder} · @ to mention`}
            className="min-w-0 flex-1 text-sm outline-none"
          />
          <button type="submit" disabled={!draft.trim() || pending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40">
            {buttonLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Row 41: a message body with @Name / @channel / @here highlighted; mentions of *you* are amber. */
function MessageBody({ body, members, meId }: { body: string; members: ChatMember[]; meId: string }) {
  const names = members
    .flatMap((m) => [
      { text: m.name, id: m.id },
      { text: m.name.split(" ")[0]!, id: m.id },
    ])
    .sort((a, b) => b.text.length - a.text.length);
  const alts = ["channel", "here", ...names.map((n) => n.text)].map(escapeRe);
  const re = new RegExp(`@(${alts.join("|")})(?![\\w])`, "gi");
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of body.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(body.slice(last, start));
    const token = match[1]!.toLowerCase();
    const special = token === "channel" || token === "here";
    const isMe = names.some((n) => n.text.toLowerCase() === token && n.id === meId);
    parts.push(
      <span key={i++} className={cn("rounded px-1 font-medium", isMe || special ? "bg-amber-100 text-amber-900" : "bg-indigo-50 text-indigo-700")}>
        {match[0]}
      </span>,
    );
    last = start + match[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{parts}</p>;
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
