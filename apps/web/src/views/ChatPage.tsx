import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Attachment, type ChannelNotify, type ChatChannel, type ChatMember, type ChatMessage, type ReactionGroup } from "../lib/api.js";
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
      <span className={cn("truncate", !active && c.unreadCount > 0 && c.notify !== "muted" && "font-semibold text-slate-900", c.notify === "muted" && "text-slate-400")}>{label}</span>
      {c.notify === "muted" && <span className="ml-auto text-[10px] text-slate-400" title="Muted">🔕</span>}
      {!active && c.unreadCount > 0 && c.notify !== "muted" && (
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
  const [filesOpen, setFilesOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

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
      if (msg.attachments?.length) qc.invalidateQueries({ queryKey: ["channel-files", channelId] });
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
    // Row 44: a reaction toggled by anyone in the channel. `reacted` is
    // recomputed for *this* viewer from the user list.
    const onReaction = (p: { messageId: string; parentMessageId: string | null; reactions: ReactionGroup[] }) =>
      applyReactions(qc, channelId, meId, p);
    socket.on("message:reaction", onReaction);
    // After a reconnect (API restart, flaky network) the server has forgotten
    // our room, so join again or live messages silently stop.
    const rejoin = () => socket.emit("join", channelId);
    socket.on("connect", rejoin);
    return () => {
      socket.emit("leave", channelId);
      socket.off("message:new", onNew);
      socket.off("message:reaction", onReaction);
      socket.off("connect", rejoin);
    };
  }, [channelId, qc, meId]);

  const react = useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) => api.reactToMessage(channelId, messageId, emoji),
    onSuccess: (p) => applyReactions(qc, channelId, meId, p),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = useMutation({
    mutationFn: ({ body, ids, files }: { body: string; ids: string[]; files: string[] }) => api.sendMessage(channelId, body, undefined, ids, files),
    // The socket echoes it too; this just makes sure it shows even if the socket is down.
    onSuccess: (msg) => {
      qc.setQueryData<ChatMessage[]>(["messages", channelId], (old = []) => (old.some((m) => m.id === msg.id) ? old : [...old, msg]));
      if (msg.attachments?.length) qc.invalidateQueries({ queryKey: ["channel-files", channelId] });
    },
  });
  const members = channel?.members ?? [];

  const title =
    channel?.type === "dm"
      ? channelLabel(channel, meId)
      : `${channel?.isPrivate && !channel.projectId ? "🔒" : "#"} ${channel?.name ?? ""}`;

  return (
    <div className="flex flex-1 overflow-hidden bg-white">
      <div ref={paneRef} className="relative flex min-w-0 flex-1 flex-col">
        <ChannelHeader channel={channel} title={title} filesOpen={filesOpen} onToggleFiles={() => setFilesOpen((v) => !v)} />

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
                  onReact={(emoji) => react.mutate({ messageId: m.id, emoji })}
                  threadOpen={threadId === m.id}
                />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <MentionComposer
          members={members}
          channelId={channelId}
          dropZoneRef={paneRef}
          placeholder={`Message ${title}`}
          pending={send.isPending}
          onSend={(body, ids, files) => send.mutate({ body, ids, files })}
        />
      </div>

      {threadId && <ThreadPane channelId={channelId} messageId={threadId} meId={meId} members={members} onClose={() => setThreadId(null)} />}
      {filesOpen && !threadId && <FilesPanel channelId={channelId} onClose={() => setFilesOpen(false)} />}
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
  onReact,
  threadOpen,
  compact,
}: {
  m: ChatMessage;
  meId: string;
  members: ChatMember[];
  grouped?: boolean;
  onReply?: () => void;
  onReact?: (emoji: string) => void;
  threadOpen?: boolean;
  compact?: boolean;
}) {
  const mine = m.author.id === meId;
  const [picker, setPicker] = useState(false);
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
        {m.body && <MessageBody body={m.body} members={members} meId={meId} />}
        {m.attachments && m.attachments.length > 0 && <AttachmentList files={m.attachments} compact={compact} />}
        {m.reactions && m.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {m.reactions.map((g) => (
              <button
                key={g.emoji}
                type="button"
                onClick={() => onReact?.(g.emoji)}
                title={g.users.map((u) => u.name).join(", ")}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition",
                  g.reacted ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-border bg-white text-slate-600 hover:border-slate-300",
                )}
              >
                <span>{g.emoji}</span>
                <span className="tabular-nums">{g.count}</span>
              </button>
            ))}
            {onReact && (
              <button type="button" onClick={() => setPicker((v) => !v)} className="rounded-full border border-dashed border-border px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-muted" title="Add reaction">
                ☺+
              </button>
            )}
          </div>
        )}
        {picker && onReact && (
          <div className="mt-1 flex w-fit gap-0.5 rounded-md border border-border bg-white p-1 shadow-lg">
            {QUICK_EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  onReact(e);
                  setPicker(false);
                }}
                className="rounded px-1.5 py-0.5 text-base hover:bg-muted"
              >
                {e}
              </button>
            ))}
          </div>
        )}
        {onReply && (m.replyCount ?? 0) > 0 && (
          <button type="button" onClick={onReply} className="mt-1 flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:underline">
            💬 {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
            {m.lastReplyAt && <span className="font-normal text-muted-foreground">· last {fmtTime(m.lastReplyAt)}</span>}
          </button>
        )}
      </div>
      {(onReply || onReact) && (
        <div className="absolute right-2 top-0 hidden items-center gap-0.5 rounded-md border border-border bg-white p-0.5 text-[11px] text-slate-600 shadow-sm group-hover:flex">
          {onReact &&
            QUICK_EMOJI.slice(0, 3).map((e) => (
              <button key={e} type="button" onClick={() => onReact(e)} className="rounded px-1 text-sm hover:bg-muted" title={`React ${e}`}>
                {e}
              </button>
            ))}
          {onReact && (
            <button type="button" onClick={() => setPicker((v) => !v)} className="rounded px-1 hover:bg-muted" title="More reactions">
              ☺+
            </button>
          )}
          {onReply && (
            <button type="button" onClick={onReply} className="rounded px-1.5 hover:bg-muted hover:text-indigo-700" title="Reply in thread">
              💬 Reply
            </button>
          )}
        </div>
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

  const react = useMutation({
    mutationFn: ({ id, emoji }: { id: string; emoji: string }) => api.reactToMessage(channelId, id, emoji),
    onSuccess: (p) => applyReactions(qc, channelId, meId, p),
  });
  const reply = useMutation({
    mutationFn: ({ body, ids, files }: { body: string; ids: string[]; files: string[] }) => api.sendMessage(channelId, body, messageId, ids, files),
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
            <MessageRow m={data.root} meId={meId} members={members} compact onReact={(emoji) => react.mutate({ id: data.root.id, emoji })} />
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {data.replies.length} {data.replies.length === 1 ? "reply" : "replies"}
              <span className="h-px flex-1 bg-border" />
            </div>
            {data.replies.map((r, i) => {
              const prev = data.replies[i - 1];
              return <MessageRow key={r.id} m={r} meId={meId} members={members} compact grouped={Boolean(prev && prev.author.id === r.author.id)} onReact={(emoji) => react.mutate({ id: r.id, emoji })} />;
            })}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        <div ref={endRef} />
      </div>
      <MentionComposer members={members} channelId={channelId} placeholder="Reply in thread…" buttonLabel="Reply" autoFocus pending={reply.isPending} onSend={(body, ids, files) => reply.mutate({ body, ids, files })} />
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
 * Row 41 + 43: a one-line composer with an @mention picker and file uploads.
 * The picker lists only people who can see this channel, plus @channel and
 * @here. Files arrive by drag-drop anywhere on the pane, paste, or the 📎
 * button; they upload immediately and go out with the next message.
 */
type PendingFile = { key: string; name: string; size: number; mimeType: string; uploading: boolean; error?: string; attachment?: Attachment; preview?: string };

function MentionComposer({
  members,
  channelId,
  dropZoneRef,
  placeholder,
  onSend,
  pending,
  autoFocus,
  buttonLabel = "Send",
}: {
  members: ChatMember[];
  channelId: string;
  dropZoneRef?: React.RefObject<HTMLDivElement>;
  placeholder: string;
  onSend: (body: string, mentionedUserIds: string[], attachmentIds: string[]) => void;
  pending?: boolean;
  autoFocus?: boolean;
  buttonLabel?: string;
}) {
  const meId = useAuth().user!.id;
  const [draft, setDraft] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
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
  useEffect(() => {
    setFiles([]);
    setDraft("");
    setIds([]);
  }, [channelId]);

  function addFiles(list: FileList | File[]) {
    const picked = Array.from(list).filter((f) => f.size > 0);
    if (!picked.length) return;
    const entries: PendingFile[] = picked.map((f) => ({
      key: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
      name: f.name,
      size: f.size,
      mimeType: f.type,
      uploading: true,
      preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
    }));
    setFiles((cur) => [...cur, ...entries]);
    entries.forEach((entry, i) => {
      api
        .uploadFile(picked[i]!, { channelId })
        .then((attachment) => setFiles((cur) => cur.map((f) => (f.key === entry.key ? { ...f, uploading: false, attachment } : f))))
        .catch((err: Error) => setFiles((cur) => cur.map((f) => (f.key === entry.key ? { ...f, uploading: false, error: err.message.includes("413") ? "Too large (25 MB max)" : "Upload failed" } : f))));
    });
  }
  function removeFile(key: string) {
    const f = files.find((x) => x.key === key);
    if (f?.attachment) void api.deleteFile(f.attachment.id).catch(() => undefined);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    setFiles((cur) => cur.filter((x) => x.key !== key));
  }

  // Drag-drop anywhere on the message pane (row 43).
  useEffect(() => {
    const zone = dropZoneRef?.current;
    if (!zone) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles(e.dataTransfer.files);
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropZoneRef, channelId]);

  function pick(s: Suggestion) {
    setDraft((d) => d.replace(/@[^\s@]*$/, `@${s.name} `));
    if (!s.special) setIds((v) => (v.includes(s.id) ? v : [...v, s.id]));
  }
  const uploading = files.some((f) => f.uploading);
  const ready = files.filter((f) => f.attachment).map((f) => f.attachment!.id);
  const canSend = (draft.trim().length > 0 || ready.length > 0) && !uploading && !pending;
  function submit() {
    if (!canSend) return;
    onSend(draft.trim(), ids, ready);
    files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
    setDraft("");
    setIds([]);
    setFiles([]);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-border p-3"
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-indigo-50/80">
          <div className="rounded-xl border-2 border-dashed border-indigo-400 bg-white px-6 py-4 text-sm font-medium text-indigo-700">📎 Drop files to share them here</div>
        </div>
      )}
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
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {files.map((f) => (
              <div key={f.key} className={cn("relative flex items-center gap-2 rounded-md border px-2 py-1 text-xs", f.error ? "border-red-300 bg-red-50 text-red-700" : "border-border bg-[#fbfbfa] text-slate-700")}>
                {f.preview ? <img src={f.preview} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="text-base">📄</span>}
                <span className="max-w-[160px] truncate">{f.name}</span>
                <span className="text-[10px] text-muted-foreground">{f.uploading ? "uploading…" : f.error ? f.error : fmtSize(f.size)}</span>
                <button type="button" onClick={() => removeFile(f.key)} className="ml-1 text-slate-400 hover:text-red-600" aria-label="Remove file">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-500/30">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          <button type="button" onClick={() => fileInput.current?.click()} title="Attach files" className="text-slate-400 hover:text-indigo-600">
            📎
          </button>
          <input
            autoFocus={autoFocus}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDismissed(null);
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
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
            placeholder={`${placeholder} · @ to mention · drop files`}
            className="min-w-0 flex-1 text-sm outline-none"
          />
          <button type="submit" disabled={!canSend} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40">
            {uploading ? "Uploading…" : buttonLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Row 43: files on a message — images inline, everything else as a card. */
function AttachmentList({ files, compact }: { files: Attachment[]; compact?: boolean }) {
  const images = files.filter((f) => f.mimeType.startsWith("image/"));
  const others = files.filter((f) => !f.mimeType.startsWith("image/"));
  return (
    <div className="mt-1.5 space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((f) => (
            <a key={f.id} href={f.url} target="_blank" rel="noreferrer" title={`${f.filename} · ${fmtSize(f.sizeBytes)}`}>
              <img src={f.url} alt={f.filename} className={cn("rounded-md border border-border object-cover", compact ? "max-h-32" : "max-h-64 max-w-sm")} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {others.map((f) => (
        <a key={f.id} href={f.url} target="_blank" rel="noreferrer" className="flex w-fit max-w-full items-center gap-2 rounded-md border border-border bg-[#fbfbfa] px-2.5 py-1.5 text-xs text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/40">
          <span className="text-base">{fileIcon(f.mimeType, f.filename)}</span>
          <span className="truncate font-medium">{f.filename}</span>
          <span className="shrink-0 text-muted-foreground">{fmtSize(f.sizeBytes)}</span>
        </a>
      ))}
    </div>
  );
}

function fileIcon(mime: string, name: string) {
  if (mime.includes("pdf")) return "📕";
  if (mime.includes("zip") || mime.includes("compressed")) return "🗜️";
  if (mime.includes("sheet") || /\.(xlsx?|csv)$/i.test(name)) return "📊";
  if (mime.includes("presentation") || /\.pptx?$/i.test(name)) return "📽️";
  if (mime.includes("word") || /\.docx?$/i.test(name)) return "📝";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  return "📄";
}

/** Row 43: everything shared in this channel, newest first — images as a grid, files as a list. */
function FilesPanel({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const { data: files = [], isLoading } = useQuery({ queryKey: ["channel-files", channelId], queryFn: () => api.getChannelFiles(channelId) });
  const images = files.filter((f) => f.mimeType.startsWith("image/"));
  const others = files.filter((f) => !f.mimeType.startsWith("image/"));
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-[#fbfbfa]">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">
          Files <span className="text-xs font-normal text-muted-foreground">{files.length}</span>
        </span>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-muted" aria-label="Close files">
          ✕
        </button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : files.length === 0 ? (
          <p className="pt-6 text-center text-sm text-muted-foreground">Nothing shared here yet. Drop a file into the conversation.</p>
        ) : (
          <>
            {images.length > 0 && (
              <section>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Images</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {images.map((f) => (
                    <a key={f.id} href={f.url} target="_blank" rel="noreferrer" title={`${f.filename} · ${f.uploadedBy?.name ?? ""}`}>
                      <img src={f.url} alt={f.filename} className="aspect-square w-full rounded-md border border-border object-cover" loading="lazy" />
                    </a>
                  ))}
                </div>
              </section>
            )}
            {others.length > 0 && (
              <section>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Files</p>
                <ul className="space-y-1">
                  {others.map((f) => (
                    <li key={f.id}>
                      <a href={f.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md border border-border bg-white px-2 py-1.5 text-xs hover:border-indigo-300">
                        <span className="text-base">{fileIcon(f.mimeType, f.filename)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-slate-800">{f.filename}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {fmtSize(f.sizeBytes)} · {f.uploadedBy?.name ?? "—"} · {new Date(f.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
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
function ChannelHeader({ channel, title, filesOpen, onToggleFiles }: { channel?: ChatChannel; title: string; filesOpen?: boolean; onToggleFiles?: () => void }) {
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
          <NotifyControl channel={channel} />
          {onToggleFiles && (
            <button type="button" onClick={onToggleFiles} className={cn("rounded-md px-2 py-1 text-xs hover:bg-muted", filesOpen ? "bg-indigo-50 text-indigo-700" : "text-slate-600")} title="Files shared in this channel">
              📎 Files
            </button>
          )}
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

const QUICK_EMOJI = ["👍", "✅", "🎉", "❤️", "😂", "👀", "🔥", "🙏"];

/** Row 44: write a message's reactions into the channel and thread caches, with `reacted` for this viewer. */
function applyReactions(qc: ReturnType<typeof useQueryClient>, channelId: string, meId: string, p: { messageId: string; reactions: ReactionGroup[] }) {
  const reactions = p.reactions.map((g) => ({ ...g, reacted: g.users.some((u) => u.id === meId) }));
  const patch = (m: ChatMessage) => (m.id === p.messageId ? { ...m, reactions } : m);
  qc.setQueryData<ChatMessage[]>(["messages", channelId], (old = []) => old.map(patch));
  qc.setQueriesData<ThreadData>({ queryKey: ["thread", channelId] }, (old) => (old ? { root: patch(old.root), replies: old.replies.map(patch) } : old));
}

const NOTIFY_LABEL: Record<ChannelNotify, { icon: string; label: string; hint: string }> = {
  all: { icon: "🔔", label: "All messages", hint: "Every message here lands in your inbox" },
  mentions: { icon: "@", label: "Mentions only", hint: "Only @you, @channel and @here" },
  muted: { icon: "🔕", label: "Muted", hint: "No notifications, no unread badge" },
};

/** Row 45: the bell in the channel header — all / mentions / muted for this channel, just for me. */
function NotifyControl({ channel }: { channel: ChatChannel }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const set = useMutation({
    mutationFn: (notify: ChannelNotify) => api.setChannelNotify(channel.id, notify),
    onSuccess: ({ notify }) => {
      qc.setQueryData<ChatChannel[]>(["channels"], (old = []) => old.map((c) => (c.id === channel.id ? { ...c, notify } : c)));
      setOpen(false);
    },
  });
  const current = NOTIFY_LABEL[channel.notify ?? "mentions"];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn("rounded-md px-2 py-1 text-xs hover:bg-muted", channel.notify === "muted" ? "text-slate-400" : "text-slate-600")}
        title={`Notifications: ${current.label}`}
      >
        {current.icon} {channel.notify === "muted" ? "Muted" : channel.notify === "all" ? "All" : "Mentions"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-md border border-border bg-white py-1 shadow-lg">
            <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Notify me about</p>
            {(Object.keys(NOTIFY_LABEL) as ChannelNotify[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => set.mutate(k)}
                className={cn("flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted", channel.notify === k && "bg-indigo-50 text-indigo-700")}
              >
                <span className="w-4 text-center">{NOTIFY_LABEL[k].icon}</span>
                <span>
                  <span className="block font-medium">{NOTIFY_LABEL[k].label}</span>
                  <span className="block text-[10px] text-muted-foreground">{NOTIFY_LABEL[k].hint}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
