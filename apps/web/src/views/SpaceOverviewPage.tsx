import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SpaceOverview } from "../lib/api.js";
import { readRecent } from "../lib/recent.js";
import { NotFound } from "../components/NotFound.js";
import { relativeTime } from "../components/TaskCollaboration.js";
import { cn } from "../lib/utils.js";

type Layout = "list" | "board" | "table";

/**
 * ClickUp-style Space Overview: header with view tabs, then cards for what's in
 * the space. Every card is a view over data the rest of the app already owns —
 * the only thing this page stores is bookmarks.
 */
export function SpaceOverviewPage() {
  const { spaceId } = useParams({ from: "/s/$spaceId" });
  const { data, isLoading, isError } = useQuery({
    queryKey: ["space-overview", spaceId],
    queryFn: () => api.getSpaceOverview(spaceId),
  });

  if (isError) return <NotFound what="space" />;
  if (isLoading || !data) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  const firstList = data.lists[0] ?? data.folders.flatMap((f) => f.lists)[0];

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      {/* Header + view tabs */}
      <div className="border-b border-border px-6 pt-3">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white" style={{ background: data.space.color ?? "#6366f1" }}>
            {data.space.name[0]}
          </span>
          <h1 className="text-sm font-semibold text-slate-800">{data.space.name}</h1>
          {data.project && (
            <Link to="/projects/$projectId" params={{ projectId: data.project.id }} className="ml-2 text-xs text-muted-foreground hover:text-indigo-700">
              Project: {data.project.name}
            </Link>
          )}
        </div>
        <div className="mt-2 flex gap-1">
          <Tab active>Overview</Tab>
          {(["list", "board", "table"] as Layout[]).map((v) =>
            firstList ? (
              <Link key={v} to="/l/$listId" params={{ listId: firstList.id }} search={{ view: v }} className={tabCls(false)}>
                {v[0]!.toUpperCase() + v.slice(1)}
              </Link>
            ) : (
              <span key={v} className={cn(tabCls(false), "opacity-40")}>{v[0]!.toUpperCase() + v.slice(1)}</span>
            ),
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-[#fbfbfa] p-5">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2"><RecentCard spaceId={spaceId} /></div>
          <DocsCard data={data} spaceId={spaceId} />
          <FoldersCard data={data} spaceId={spaceId} />
          <ListsCard data={data} spaceId={spaceId} />
          <BookmarksCard data={data} spaceId={spaceId} />
          <WorkloadCard workload={data.workload} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

function RecentCard({ spaceId }: { spaceId: string }) {
  const recent = useMemo(() => readRecent(spaceId).slice(0, 8), [spaceId]);
  return (
    <Card title="Recent">
      {recent.length ? (
        <ul className="space-y-1">
          {recent.map((r) => (
            <li key={r.listId}>
              <Link to="/l/$listId" params={{ listId: r.listId }} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-muted">
                <ListIcon />
                <span className="truncate">{r.listName}</span>
                <span className="text-xs text-muted-foreground">· in {r.spaceName}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">{relativeTime(new Date(r.at).toISOString())}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Lists you open in this space will show up here.</Empty>
      )}
    </Card>
  );
}

function DocsCard({ data, spaceId }: { data: SpaceOverview; spaceId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.createDocument({ title: "Untitled document", projectId: data.project?.id ?? null }),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ["space-overview", spaceId] });
      navigate({ to: "/docs/$docId", params: { docId: doc.id } });
    },
  });
  return (
    <Card title="Docs" action={<CardAction onClick={() => create.mutate()}>New doc</CardAction>}>
      {data.docs.length ? (
        <ul className="space-y-1">
          {data.docs.map((d) => (
            <li key={d.id}>
              <Link to="/docs/$docId" params={{ docId: d.id }} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-muted">
                <DocIcon />
                <span className="truncate">{d.title}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">{relativeTime(d.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          {data.project ? "No docs on this project yet." : "Wrap this space in a project to attach docs to it — or create an unlinked doc."}
        </Empty>
      )}
    </Card>
  );
}

function FoldersCard({ data, spaceId }: { data: SpaceOverview; spaceId: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["space-overview", spaceId] });
    qc.invalidateQueries({ queryKey: ["spaces"] });
  };
  const create = useMutation({
    mutationFn: () => api.createFolder(spaceId, name.trim()),
    onSuccess: () => {
      setName("");
      setAdding(false);
      refresh();
    },
  });
  return (
    <Card title="Folders" action={<CardAction onClick={() => setAdding((a) => !a)}>New folder</CardAction>}>
      {adding && (
        <InlineForm value={name} onChange={setName} placeholder="Folder name" onSubmit={() => name.trim() && create.mutate()} busy={create.isPending} />
      )}
      {data.folders.length ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {data.folders.map((f) => (
            <li key={f.id} className="rounded-md border border-border bg-white px-3 py-2">
              <p className="flex items-center gap-2 text-sm font-medium text-slate-800"><FolderIcon />{f.name}</p>
              <ul className="mt-1 space-y-0.5">
                {f.lists.map((l) => (
                  <li key={l.id}>
                    <Link to="/l/$listId" params={{ listId: l.id }} className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-slate-600 hover:bg-muted">
                      <ListIcon />{l.name}
                      <span className="ml-auto text-[10px] text-muted-foreground">{l.tasksDone}/{l.tasksTotal}</span>
                    </Link>
                  </li>
                ))}
                <li><AddListInline spaceId={spaceId} folderId={f.id} /></li>
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        !adding && <Empty>Group lists into folders — sprints, clients, phases.</Empty>
      )}
    </Card>
  );
}

function ListsCard({ data, spaceId }: { data: SpaceOverview; spaceId: string }) {
  return (
    <Card title="Lists">
      {data.lists.length ? (
        <ul className="space-y-1">
          {data.lists.map((l) => {
            const pct = l.tasksTotal ? Math.round((l.tasksDone / l.tasksTotal) * 100) : 0;
            return (
              <li key={l.id}>
                <Link to="/l/$listId" params={{ listId: l.id }} className="block rounded-md px-2 py-1.5 hover:bg-muted">
                  <span className="flex items-center gap-2 text-sm text-slate-700">
                    <ListIcon />
                    <span className="truncate">{l.name}</span>
                    <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{l.tasksDone}/{l.tasksTotal}</span>
                  </span>
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-slate-100">
                    <span className="block h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>Add a new List to your Space.</Empty>
      )}
      <div className="mt-2"><AddListInline spaceId={spaceId} /></div>
    </Card>
  );
}

function BookmarksCard({ data, spaceId }: { data: SpaceOverview; spaceId: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["space-overview", spaceId] });
  const add = useMutation({
    mutationFn: () => api.addBookmark(spaceId, { title: title.trim(), url: url.trim() }),
    onSuccess: () => {
      setTitle("");
      setUrl("");
      setAdding(false);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.removeBookmark(spaceId, id), onSuccess: refresh });

  return (
    <Card title="Bookmarks" action={<CardAction onClick={() => setAdding((a) => !a)}>Add bookmark</CardAction>}>
      {adding && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (title.trim() && url.trim()) add.mutate();
          }}
          className="mb-2 space-y-1.5"
        >
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={inputCls} />
          <div className="flex gap-1.5">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={inputCls} />
            <button type="submit" disabled={add.isPending} className="shrink-0 rounded-md bg-indigo-600 px-2.5 text-xs font-medium text-white disabled:opacity-50">Save</button>
          </div>
        </form>
      )}
      {data.bookmarks.length ? (
        <ul className="space-y-1">
          {data.bookmarks.map((b) => (
            <li key={b.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <BookmarkIcon />
              <a href={b.url} target="_blank" rel="noreferrer" className="truncate text-slate-700 hover:text-indigo-700">{b.title}</a>
              <span className="truncate text-[11px] text-muted-foreground">{hostOf(b.url)}</span>
              <button onClick={() => remove.mutate(b.id)} className="ml-auto text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-500">✕</button>
            </li>
          ))}
        </ul>
      ) : (
        !adding && <Empty>Bookmarks make it easy to keep any URL close to this space.</Empty>
      )}
    </Card>
  );
}

/** Donut of open tasks by status. Colours are the statuses' own. */
function WorkloadCard({ workload }: { workload: SpaceOverview["workload"] }) {
  const total = workload.reduce((a, w) => a + w.count, 0);
  const R = 44;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segments = workload.map((w) => {
    const frac = total ? w.count / total : 0;
    const seg = { ...w, dash: frac * C, offset };
    offset += frac * C;
    return seg;
  });

  return (
    <Card title="Workload by Status">
      {total ? (
        <div className="flex items-center gap-6">
          <svg viewBox="0 0 120 120" className="h-36 w-36 shrink-0" role="img" aria-label={`${total} tasks by status`}>
            {segments.map((s) => (
              <circle
                key={s.statusId ?? "none"}
                cx="60" cy="60" r={R}
                fill="none" stroke={s.color} strokeWidth="18"
                strokeDasharray={`${s.dash} ${C - s.dash}`}
                strokeDashoffset={-s.offset}
                transform="rotate(-90 60 60)"
              >
                <title>{`${s.name}: ${s.count}`}</title>
              </circle>
            ))}
            <text x="60" y="56" textAnchor="middle" className="fill-slate-900" style={{ fontSize: 18, fontWeight: 600 }}>{total}</text>
            <text x="60" y="72" textAnchor="middle" className="fill-slate-500" style={{ fontSize: 9 }}>tasks</text>
          </svg>
          <ul className="min-w-0 flex-1 space-y-1.5">
            {segments.map((s) => (
              <li key={s.statusId ?? "none"} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="truncate text-slate-700">{s.name}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{s.count} · {total ? Math.round((s.count / total) * 100) : 0}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Empty>No open tasks in this space yet.</Empty>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Bits
 * ------------------------------------------------------------------ */

function AddListInline({ spaceId, folderId }: { spaceId: string; folderId?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createList(spaceId, name.trim(), folderId),
    onSuccess: (list) => {
      setName("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["space-overview", spaceId] });
      qc.invalidateQueries({ queryKey: ["spaces"] });
      navigate({ to: "/l/$listId", params: { listId: list.id } });
    },
  });
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={cn("rounded px-1 py-0.5 text-xs font-medium text-indigo-600 hover:text-indigo-700", !folderId && "text-sm")}>
        + Add List
      </button>
    );
  }
  return <InlineForm value={name} onChange={setName} placeholder="List name" onSubmit={() => name.trim() && create.mutate()} busy={create.isPending} onCancel={() => setOpen(false)} />;
}

function InlineForm({ value, onChange, placeholder, onSubmit, busy, onCancel }: { value: string; onChange: (v: string) => void; placeholder: string; onSubmit: () => void; busy: boolean; onCancel?: () => void }) {
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
      className="mb-2 flex gap-1.5"
    >
      <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} onKeyDown={(e) => e.key === "Escape" && onCancel?.()} className={inputCls} />
      <button type="submit" disabled={!value.trim() || busy} className="shrink-0 rounded-md bg-indigo-600 px-2.5 text-xs font-medium text-white disabled:opacity-50">Add</button>
    </form>
  );
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-white">
      <div className="flex items-center border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        <div className="ml-auto">{action}</div>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function CardAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button onClick={onClick} className="rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50">{children}</button>;
}

function Tab({ active, children }: { active?: boolean; children: ReactNode }) {
  return <span className={tabCls(Boolean(active))}>{children}</span>;
}

function tabCls(active: boolean) {
  return cn(
    "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
    active ? "border-indigo-600 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700",
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const inputCls =
  "min-w-0 flex-1 rounded-md border border-border bg-white px-2.5 py-1.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

const ListIcon = () => (
  <svg className="h-3.5 w-3.5 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="2" /></svg>
);
const DocIcon = () => (
  <svg className="h-3.5 w-3.5 shrink-0 text-sky-500" viewBox="0 0 24 24" fill="none"><path d="M7 3h7l5 5v13H7zM14 3v5h5" stroke="currentColor" strokeWidth="1.8" /></svg>
);
const FolderIcon = () => (
  <svg className="h-3.5 w-3.5 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="1.8" /></svg>
);
const BookmarkIcon = () => (
  <svg className="h-3.5 w-3.5 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none"><path d="M6 3h12v18l-6-4-6 4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
);
