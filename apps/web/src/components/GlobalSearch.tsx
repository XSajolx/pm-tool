import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type SearchHit } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Row 123: one box for everything. Ctrl/⌘+K opens it anywhere; results are
 * grouped by type and reachable with the arrow keys. Docs are full-text.
 */
const ICON: Record<string, string> = { task: "☐", project: "▣", document: "📄", contact: "👤", company: "🏢", message: "💬", comment: "💭" };

export function useGlobalSearchShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isFetching } = useQuery({ queryKey: ["search", debounced], queryFn: () => api.search(debounced), enabled: debounced.length >= 2, placeholderData: (prev) => prev });
  const flat = useMemo(() => (data?.groups ?? []).flatMap((g) => g.items.map((h) => ({ ...h, type: g.type }))), [data]);
  useEffect(() => setCursor(0), [debounced]);

  const go = (hit: SearchHit) => {
    onClose();
    const n = hit.nav;
    if (n.kind === "task" && n.id) navigate({ to: "/t/$taskId", params: { taskId: n.id } });
    else if (n.kind === "project" && n.id) navigate({ to: "/projects/$projectId", params: { projectId: n.id } });
    else if (n.kind === "document" && n.id) navigate({ to: "/docs/$docId", params: { docId: n.id } });
    else if (n.kind === "company" && n.id) navigate({ to: "/crm/companies/$companyId", params: { companyId: n.id } });
    else if (n.kind === "contacts") navigate({ to: "/crm/contacts" });
    else if (n.kind === "channel" && n.id) navigate({ to: "/chat/$channelId", params: { channelId: n.id } });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter" && flat[cursor]) { e.preventDefault(); go(flat[cursor]!); }
    else if (e.key === "Escape") onClose();
  };

  let index = -1;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 px-4 pt-[12vh]" onClick={onClose} data-testid="global-search">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <span className="text-slate-400">⌕</span>
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search tasks, projects, docs, contacts, chat, comments…"
            className="w-full bg-transparent py-3 text-sm outline-none"
            aria-label="Search"
          />
          {isFetching && <span className="text-xs text-muted-foreground">…</span>}
          <kbd className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {debounced.length < 2 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">Type at least two characters. Tip: press <kbd className="rounded border border-border px-1 text-[10px]">Ctrl</kbd>+<kbd className="rounded border border-border px-1 text-[10px]">K</kbd> anywhere.</p>
          ) : !data || !data.groups.length ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">{isFetching ? "Searching…" : `Nothing matches “${debounced}”.`}</p>
          ) : (
            data.groups.map((g) => (
              <div key={g.type} className="mb-2">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.label} <span className="font-normal">{g.items.length}</span></p>
                <ul>
                  {g.items.map((h) => {
                    index += 1;
                    const i = index;
                    return (
                      <li key={h.id}>
                        <button
                          type="button"
                          onMouseEnter={() => setCursor(i)}
                          onClick={() => go(h)}
                          className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left", i === cursor ? "bg-indigo-50" : "hover:bg-muted")}
                        >
                          <span className="mt-0.5 w-5 shrink-0 text-center text-xs text-slate-500">{h.color ? <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: h.color }} /> : ICON[g.type] ?? "•"}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-slate-800">{h.title}</span>
                            {h.subtitle && <span className="block truncate text-xs text-muted-foreground">{h.subtitle}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
