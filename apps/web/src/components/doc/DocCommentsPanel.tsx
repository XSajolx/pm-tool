import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DocThread } from "../../lib/api.js";
import { Avatar } from "../ui.js";
import { relativeTime } from "../TaskCollaboration.js";
import { cn } from "../../lib/utils.js";

/**
 * Row 16: the comment threads of a doc. Highlight text → "Comment" fills the
 * composer with the quote; posting marks the text; resolving clears the mark.
 */
export function DocCommentsPanel({ docId, pending, onClearPending, onClose, focusId }: { docId: string; pending: { from: number; to: number; quote: string } | null; onClearPending: () => void; onClose: () => void; focusId: string | null }) {
  const qc = useQueryClient();
  const key = ["doc-comments", docId];
  const { data: threads = [] } = useQuery({ queryKey: key, queryFn: () => api.getDocComments(docId), refetchInterval: 30_000 });
  const [showResolved, setShowResolved] = useState(false);
  const [body, setBody] = useState("");
  const [reply, setReply] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () => api.createDocComment(docId, { body: body.trim(), quote: pending?.quote ?? null }),
    onSuccess: (c) => {
      if (pending) window.dispatchEvent(new CustomEvent("pm-doc-comment-mark", { detail: { from: pending.from, to: pending.to, commentId: c.id } }));
      setBody("");
      onClearPending();
      refresh();
    },
  });
  const replyTo = useMutation({
    mutationFn: ({ parentId, text }: { parentId: string; text: string }) => api.createDocComment(docId, { body: text, parentId }),
    onSuccess: (_c, v) => { setReply((r) => ({ ...r, [v.parentId]: "" })); refresh(); },
  });
  const resolve = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) => api.resolveDocComment(docId, id, resolved),
    onSuccess: (c) => { if (c.resolvedAt) window.dispatchEvent(new CustomEvent("pm-doc-comment-unmark", { detail: { commentId: c.id } })); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDocComment(docId, id),
    onSuccess: (_r, id) => { window.dispatchEvent(new CustomEvent("pm-doc-comment-unmark", { detail: { commentId: id } })); refresh(); },
  });
  useEffect(() => {
    if (focusId) listRef.current?.querySelector<HTMLElement>(`[data-thread="${focusId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, threads.length]);
  const open = threads.filter((t) => !t.resolvedAt);
  const resolved = threads.filter((t) => t.resolvedAt);
  const visible = showResolved ? threads : open;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-[#fbfbfa]" data-testid="doc-comments">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Comments</h2>
        <span className="text-[11px] text-muted-foreground">{open.length} open{resolved.length ? ` · ${resolved.length} resolved` : ""}</span>
        <button type="button" onClick={onClose} className="ml-auto text-xs text-muted-foreground hover:text-slate-700">✕</button>
      </div>
      {pending && (
        <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) create.mutate(); }} className="border-b border-amber-200 bg-amber-50 p-3" data-testid="doc-comment-composer">
          <p className="mb-1 truncate border-l-2 border-amber-400 pl-2 text-xs italic text-amber-900" title={pending.quote}>“{pending.quote || "(selection)"}”</p>
          <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Say what should change, or ask a question…" className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-400" />
          <div className="mt-1.5 flex items-center gap-2">
            <button type="submit" disabled={!body.trim() || create.isPending} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Comment</button>
            <button type="button" onClick={onClearPending} className="text-xs text-muted-foreground hover:text-slate-700">Cancel</button>
          </div>
        </form>
      )}
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {visible.length === 0 && (
          <p className="text-xs text-muted-foreground">{threads.length ? "Everything is resolved." : "No comments yet. Select some text and press Comment."}</p>
        )}
        {visible.map((t: DocThread) => (
          <div key={t.id} data-thread={t.id} className={cn("rounded-lg border bg-white p-2.5", t.id === focusId ? "border-indigo-400" : "border-border", t.resolvedAt && "opacity-70")}>
            {t.quote && <p className="mb-1 truncate border-l-2 border-amber-300 pl-2 text-[11px] italic text-slate-500" title={t.quote}>“{t.quote}”</p>}
            <CommentLine c={t} onDelete={() => remove.mutate(t.id)} />
            {t.replies.map((r) => <CommentLine key={r.id} c={r} onDelete={() => remove.mutate(r.id)} reply />)}
            <div className="mt-1.5 flex items-center gap-2">
              {!t.resolvedAt ? (
                <>
                  <input value={reply[t.id] ?? ""} onChange={(e) => setReply((m) => ({ ...m, [t.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter" && (reply[t.id] ?? "").trim()) { e.preventDefault(); replyTo.mutate({ parentId: t.id, text: (reply[t.id] ?? "").trim() }); } }} placeholder="Reply…" className="min-w-0 flex-1 rounded-md border border-border bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400" />
                  <button type="button" onClick={() => resolve.mutate({ id: t.id, resolved: true })} className="text-[11px] text-green-700 hover:underline" title="Mark this thread as resolved (clears the highlight)">Resolve</button>
                </>
              ) : (
                <>
                  <span className="text-[11px] text-muted-foreground">Resolved{t.resolvedBy ? ` by ${t.resolvedBy.name}` : ""} {relativeTime(t.resolvedAt)}</span>
                  <button type="button" onClick={() => resolve.mutate({ id: t.id, resolved: false })} className="ml-auto text-[11px] text-indigo-700 hover:underline">Reopen</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {resolved.length > 0 && (
        <div className="border-t border-border px-3 py-1.5">
          <button type="button" onClick={() => setShowResolved((v) => !v)} className="text-[11px] text-muted-foreground hover:text-slate-700">{showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`}</button>
        </div>
      )}
    </aside>
  );
}

function CommentLine({ c, onDelete, reply }: { c: DocThread | DocThread["replies"][number]; onDelete: () => void; reply?: boolean }) {
  return (
    <div className={cn("flex gap-2 py-1", reply && "ml-3 border-l border-border pl-2")}>
      {c.author ? <Avatar user={{ id: c.author.id, name: c.author.name, avatarUrl: c.author.avatarUrl, email: "", role: "member" }} size={18} /> : <span className="h-[18px] w-[18px] rounded-full bg-slate-200" />}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground"><span className="font-medium text-slate-800">{c.author?.name ?? "Someone"}</span> · {relativeTime(c.createdAt)}
          <button type="button" onClick={onDelete} className="ml-2 text-slate-300 hover:text-red-600" title="Delete">×</button>
        </p>
        <p className="whitespace-pre-wrap text-sm text-slate-800">{c.body}</p>
      </div>
    </div>
  );
}
