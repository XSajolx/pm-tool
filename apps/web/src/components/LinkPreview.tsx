import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { StatusPill } from "./ui.js";
import { cn } from "../lib/utils.js";

/**
 * Row 48: links to things inside the app render as live cards. A card only
 * appears when the viewer can actually open the target — the lookup runs as
 * the viewer, so a 403/404 simply shows nothing.
 */
export type AppLinkKind = "task" | "doc" | "company" | "project";
export interface AppLink {
  kind: AppLinkKind;
  id: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATTERNS: { kind: AppLinkKind; re: RegExp }[] = [
  { kind: "task", re: new RegExp(`/t/(${UUID})`, "i") },
  { kind: "task", re: new RegExp(`[?&]task=(${UUID})`, "i") },
  { kind: "doc", re: new RegExp(`/docs/(${UUID})`, "i") },
  { kind: "company", re: new RegExp(`/crm/companies/(${UUID})`, "i") },
  { kind: "project", re: new RegExp(`/projects/(${UUID})`, "i") },
];
export const URL_RE = /https?:\/\/[^\s<>"'\])]+/gi;

/** Is this URL one of ours (same origin, or a bare in-app path)? */
export function parseAppLink(url: string): AppLink | null {
  let path = url;
  try {
    if (/^https?:/i.test(url)) {
      const u = new URL(url);
      if (typeof window !== "undefined" && u.origin !== window.location.origin) return null;
      path = u.pathname + u.search;
    }
  } catch {
    return null;
  }
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(path);
    if (m) return { kind, id: m[1]!.toLowerCase() };
  }
  return null;
}

/** Every in-app link in a piece of text, deduplicated, in order of appearance. */
export function findAppLinks(text: string): AppLink[] {
  const out: AppLink[] = [];
  const seen = new Set<string>();
  const push = (l: AppLink | null) => {
    if (!l) return;
    const key = `${l.kind}:${l.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };
  for (const m of text.matchAll(URL_RE)) push(parseAppLink(m[0]));
  // Bare paths people paste from the address bar without the origin.
  for (const m of text.matchAll(new RegExp(`(?:^|\\s)(/(?:t|docs|crm/companies|projects)/${UUID})`, "gi"))) push(parseAppLink(m[1]!));
  return out;
}

export function LinkPreviews({ text, compact }: { text: string; compact?: boolean }) {
  const links = findAppLinks(text);
  if (!links.length) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {links.slice(0, 4).map((l) => (
        <LinkPreviewCard key={`${l.kind}:${l.id}`} link={l} compact={compact} />
      ))}
    </div>
  );
}

const card = "flex w-fit max-w-full items-start gap-2 rounded-md border border-border bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/40";

export function LinkPreviewCard({ link, compact }: { link: AppLink; compact?: boolean }) {
  if (link.kind === "task") return <TaskCard id={link.id} compact={compact} />;
  if (link.kind === "doc") return <DocCard id={link.id} />;
  if (link.kind === "company") return <CompanyCard id={link.id} />;
  return <ProjectCard id={link.id} />;
}

function TaskCard({ id, compact }: { id: string; compact?: boolean }) {
  const { data: t, isError } = useQuery({ queryKey: ["preview", "task", id], queryFn: () => api.getTask(id), retry: false, staleTime: 30_000 });
  if (isError || !t) return null;
  const due = t.dueDate ? new Date(t.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  return (
    <Link to="/t/$taskId" params={{ taskId: t.id }} className={card} title="Open task">
      <span className="text-sm">✓</span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          {t.reference && <span className="text-[10px] text-muted-foreground">{t.reference}</span>}
          <span className={cn("truncate font-medium text-slate-800", t.status?.category === "done" && "line-through opacity-70")}>{t.title}</span>
        </span>
        {!compact && (
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            {t.status && <StatusPill name={t.status.name} color={t.status.color} />}
            {t.assignees?.length ? <span>{t.assignees.map((a) => a.user.name.split(" ")[0]).join(", ")}</span> : <span>Unassigned</span>}
            {due && <span>· due {due}</span>}
            {t.priority && <span>· {t.priority}</span>}
          </span>
        )}
      </span>
    </Link>
  );
}

function DocCard({ id }: { id: string }) {
  const { data: d, isError } = useQuery({ queryKey: ["preview", "doc", id], queryFn: () => api.getDocument(id), retry: false, staleTime: 30_000 });
  if (isError || !d) return null;
  return (
    <Link to="/docs/$docId" params={{ docId: d.id }} className={card} title="Open doc">
      <span className="text-sm">{d.icon ?? "📄"}</span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-slate-800">{d.title || "Untitled"}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          Doc{d.project ? ` · ${d.project.name}` : ""}
          {d.updatedBy ? ` · edited by ${d.updatedBy.name}` : ""}
        </span>
      </span>
    </Link>
  );
}

function CompanyCard({ id }: { id: string }) {
  const { data: c, isError } = useQuery({ queryKey: ["preview", "company", id], queryFn: () => api.getCompany(id), retry: false, staleTime: 30_000 });
  if (isError || !c) return null;
  return (
    <Link to="/crm/companies/$companyId" params={{ companyId: c.id }} className={card} title="Open company">
      <span className="text-sm">🏢</span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-slate-800">{c.name}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {[c.industry, c.owner ? `owner ${c.owner.name}` : null, c.deals?.length ? `${c.deals.length} deal${c.deals.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ") || "Client"}
        </span>
      </span>
    </Link>
  );
}

function ProjectCard({ id }: { id: string }) {
  const { data: p, isError } = useQuery({ queryKey: ["preview", "project", id], queryFn: () => api.getProject(id), retry: false, staleTime: 30_000 });
  if (isError || !p) return null;
  return (
    <Link to="/projects/$projectId" params={{ projectId: p.id }} className={card} title="Open project">
      <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: p.color }} />
      <span className="min-w-0">
        <span className="block truncate font-medium text-slate-800">{p.name}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {p.status.replace("_", " ")} · {p.stats.tasksDone}/{p.stats.tasksTotal} tasks done{p.clientName ? ` · ${p.clientName}` : ""}
        </span>
      </span>
    </Link>
  );
}
