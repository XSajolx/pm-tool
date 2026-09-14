import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SpaceTree } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { closeSocket, getSocket } from "../lib/socket.js";
import { TimerBar } from "./TimerBar.js";
import { QuickAdd, useQuickAddShortcut } from "./QuickAdd.js";
import { InviteDialog, NewSpaceDialog } from "./SidebarDialogs.js";
import { cn } from "../lib/utils.js";

export function Sidebar() {
  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces });
  const { user, memberships, activeOrgId, role, switchOrg, signOut } = useAuth();
  const qc = useQueryClient();
  const { data: unreadData } = useQuery({
    queryKey: ["unread-count"],
    queryFn: api.getUnreadCount,
  });
  const unread = unreadData?.count ?? 0;
  // Row 42: total unread chat messages across my channels.
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: api.getChannels });
  const chatUnread = channels.reduce((n, c) => n + (c.notify !== "muted" ? (c.unreadCount ?? 0) : 0), 0);

  // The server pushes notification:new into this user's personal room, so the
  // badge updates without polling. Refetching (rather than incrementing) keeps
  // it correct when the same person has two tabs open.
  useEffect(() => {
    const socket = getSocket();
    const bump = () => {
      qc.invalidateQueries({ queryKey: ["unread-count"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    };
    socket.on("notification:new", bump);
    // Row 42: a new message in any of my channels, or a read mark from another
    // device, changes the unread badges.
    const chatChanged = () => qc.invalidateQueries({ queryKey: ["channels"] });
    socket.on("chat:unread", chatChanged);
    socket.on("chat:read", chatChanged);
    return () => {
      socket.off("notification:new", bump);
      socket.off("chat:unread", chatChanged);
      socket.off("chat:read", chatChanged);
    };
  }, [qc]);
  const [orgMenu, setOrgMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [spaceDialog, setSpaceDialog] = useState(false);
  const [quickAdd, setQuickAdd] = useState(false);
  const openQuickAdd = useCallback(() => setQuickAdd(true), []);
  useQuickAddShortcut(openQuickAdd);
  const [inviteDialog, setInviteDialog] = useState(false);

  const activeOrg = memberships.find((m) => m.organizationId === activeOrgId)?.organization;
  const initials = (user?.name ?? "?")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col overflow-hidden border-r border-border bg-[#fbfbfa]">
      {/* Workspace switcher */}
      <div className="relative border-b border-border">
        <button
          onClick={() => setOrgMenu((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-3 text-left hover:bg-muted"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-indigo-600 text-xs font-bold text-white">
            {(activeOrg?.name ?? "?").slice(0, 2).toUpperCase()}
          </span>
          <span className="truncate text-sm font-semibold">
            {activeOrg?.name ?? "Workspace"}
          </span>
          <svg className="ml-auto h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>

        {orgMenu && (
          <div className="absolute left-2 right-2 top-full z-20 mt-1 rounded-md border border-border bg-white py-1 shadow-lg">
            {memberships.map((m) => (
              <button
                key={m.organizationId}
                onClick={() => {
                  switchOrg(m.organizationId);
                  setOrgMenu(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted",
                  m.organizationId === activeOrgId && "font-medium text-indigo-700",
                )}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-indigo-100 text-[10px] font-bold text-indigo-700">
                  {m.organization.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate">{m.organization.name}</span>
                <span className="ml-auto text-[11px] capitalize text-muted-foreground">
                  {m.role}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Scrollable middle: nav sections + spaces */}
      <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Primary nav */}
      <nav className="px-2 py-2">
        <button
          type="button"
          onClick={openQuickAdd}
          title="New task (press n)"
          className="mb-1 flex w-full items-center gap-2.5 rounded-md border border-dashed border-indigo-300 px-2 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
        >
          <span className="text-base leading-none">＋</span>
          New task
          <kbd className="ml-auto rounded border border-indigo-200 px-1 text-[10px] font-normal text-indigo-400">n</kbd>
        </button>
        <Link
          to="/chat"
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-muted [&.active]:bg-indigo-50 [&.active]:font-medium [&.active]:text-indigo-700"
        >
          <svg className="h-4 w-4 opacity-70" viewBox="0 0 24 24" fill="none">
            <path
              d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
              stroke="currentColor"
              strokeWidth="1.8"
            />
          </svg>
          Chat
          {chatUnread > 0 && (
            <span className="ml-auto min-w-[18px] rounded-full bg-indigo-600 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white">
              {chatUnread > 99 ? "99+" : chatUnread}
            </span>
          )}
        </Link>
        <NavLink to="/my-work" label="My Work" icon={checkIcon} />
        <NavLink to="/inbox" label="Home" badge={unread} icon={bellIcon} />
        <NavLink to="/intake" label="Intake" icon={inboxIcon} />
        <NavLink to="/docs" label="Docs" icon={docIcon} />
        <NavLink to="/dashboards" label="Dashboards" icon={chartIcon} />
      </nav>

      {/* CRM */}
      <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        CRM
      </p>
      <nav className="px-2">
        <NavLink to="/crm/companies" label="Companies" icon={buildingIcon} />
        <NavLink to="/crm/contacts" label="Contacts" icon={contactIcon} />
        <NavLink to="/crm/deals" label="Deals" icon={dealIcon} />
        <NavLink to="/crm/proposals" label="Proposals" icon={estimateIcon} />
        <NavLink to="/crm/estimates" label="Estimates" icon={estimateIcon} />
        <NavLink to="/crm/meetings" label="Meetings" icon={meetingIcon} />
      </nav>

      {/* Productivity */}
      <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Productivity
      </p>
      <nav className="px-2">
        <NavLink to="/projects" label="Projects" icon={folderIcon} />
        <NavLink to="/time" label="Time Tracking" icon={clockIcon} />
        <NavLink to="/timesheets" label="Timesheets" icon={gridIcon} />
        <NavLink to="/resourcing" label="Resourcing" icon={peopleIcon} />
      </nav>

      <nav className="px-2 pt-2">
        <NavLink to="/settings" label="Settings" icon={gearIcon} />
      </nav>

      {/* Spaces */}
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Spaces
        </span>
        <button onClick={() => setSpaceDialog(true)} title="New space" className="text-muted-foreground hover:text-slate-700">＋</button>
      </div>
      <div className="px-1 pb-2">
        {spaces.map((s) => (
          <SpaceNode key={s.id} space={s} />
        ))}
      </div>
      </div>

      {spaceDialog && <NewSpaceDialog onClose={() => setSpaceDialog(false)} />}
      <QuickAdd open={quickAdd} onClose={() => setQuickAdd(false)} />
      {inviteDialog && <InviteDialog onClose={() => setInviteDialog(false)} />}

      <TimerBar />

      {/* Footer — signed-in user */}
      <div className="relative border-t border-border p-2">
        {/* Inviting people is admin/owner work; members just don't see it. */}
        {(role === "owner" || role === "admin") && (
          <button onClick={() => setInviteDialog(true)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-muted">
            <span className="text-base">＋</span> Invite people
          </button>
        )}

        <button
          onClick={() => setUserMenu((o) => !o)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">
            {initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-slate-700">{user?.name}</span>
            <span className="block truncate text-[11px] capitalize text-muted-foreground">
              {role ?? "member"}
            </span>
          </span>
        </button>

        {userMenu && (
          <div className="absolute bottom-full left-2 right-2 z-20 mb-1 rounded-md border border-border bg-white py-1 shadow-lg">
            <div className="truncate px-3 py-1.5 text-[11px] text-muted-foreground">
              {user?.email}
            </div>
            <button
              onClick={() => {
                setUserMenu(false);
                closeSocket();
                void signOut();
              }}
              className="w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-muted"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function SpaceNode({ space }: { space: SpaceTree }) {
  const [open, setOpen] = useState(true);
  const color = space.color ?? "#6366f1";
  return (
    <div className="mb-0.5">
      <div className="flex items-center rounded-md hover:bg-muted">
        <button
          onClick={() => setOpen((o) => !o)}
          title={open ? "Collapse" : "Expand"}
          className="px-2 py-1.5"
        >
          <svg
            className={cn("h-3 w-3 text-slate-400 transition", open && "rotate-90")}
            viewBox="0 0 24 24"
            fill="none"
          >
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
        <Link
          to="/s/$spaceId"
          params={{ spaceId: space.id }}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-sm font-medium text-slate-700 [&.active]:text-indigo-700"
        >
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
            style={{ background: color }}
          >
            {space.name[0]}
          </span>
          <span className="truncate">{space.name}</span>
        </Link>
      </div>
      {open && (
        <div className="ml-4 border-l border-border pl-1">
          {space.lists.map((l) => (
            <ListLink key={l.id} id={l.id} name={l.name} />
          ))}
          {space.folders.map((f) => (
            <div key={f.id}>
              <div className="flex items-center gap-1.5 px-2 py-1 text-sm text-slate-600">
                📁 {f.name}
              </div>
              <div className="ml-3">
                {f.lists.map((l) => (
                  <ListLink key={l.id} id={l.id} name={l.name} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ListLink({ id, name }: { id: string; name: string }) {
  const params = useParams({ strict: false }) as { listId?: string };
  const active = params.listId === id;
  return (
    <Link
      to="/l/$listId"
      params={{ listId: id }}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition",
        active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-muted",
      )}
    >
      <svg className="h-3.5 w-3.5 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none">
        <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="2" />
      </svg>
      {name}
    </Link>
  );
}

const ICONS: Record<string, string> = {
  home: "M3 11l9-8 9 8M5 10v10h14V10",
  inbox: "M3 12h5l2 3h4l2-3h5M4 6h16v12H4z",
  doc: "M6 2h9l5 5v15H6zM14 2v6h6",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
};

export function NavItem({ icon, label, badge }: { icon: string; label: string; badge?: string }) {
  return (
    <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-muted">
      <svg className="h-4 w-4 opacity-70" viewBox="0 0 24 24" fill="none">
        <path d={ICONS[icon]} stroke="currentColor" strokeWidth="1.8" />
      </svg>
      {label}
      {badge && (
        <span className="ml-auto rounded-full bg-indigo-100 px-1.5 text-[10px] font-semibold text-indigo-700">
          {badge}
        </span>
      )}
    </button>
  );
}

const checkIcon = (
  <svg className="h-4 w-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const gearIcon = (
  <svg className="h-4 w-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </svg>
);
const docIcon = (
  <path d="M7 3h7l5 5v13H7zM14 3v5h5M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
);
const chartIcon = (
  <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
);

const buildingIcon = (
  <path d="M4 21V5a2 2 0 012-2h8a2 2 0 012 2v16M4 21h16M8 7h4M8 11h4M8 15h4M16 11h4v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
);
const contactIcon = (
  <path d="M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21a8 8 0 0116 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
);
const dealIcon = (
  <path d="M3 17l6-6 4 4 8-8M14 7h7v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
);
const estimateIcon = (
  <path d="M7 3h7l5 5v13H7zM14 3v5h5M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
);
const meetingIcon = (
  <path d="M4 5h16v15H4zM4 10h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
);

const folderIcon = (
  <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="1.8" />
);
const clockIcon = (
  <>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </>
);
const gridIcon = (
  <path d="M4 5h16v14H4zM4 10h16M4 15h16M9 5v14M15 5v14" stroke="currentColor" strokeWidth="1.6" />
);
const peopleIcon = (
  <path d="M16 11a3 3 0 10-6 0 3 3 0 006 0zM5 20a6 6 0 0112 0M19 8a2.5 2.5 0 110 5M21 20a5 5 0 00-3-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
);

const bellIcon = (
  <path
    d="M18 8a6 6 0 10-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9z"
    stroke="currentColor"
    strokeWidth="1.8"
  />
);

const inboxIcon = (
  <path
    d="M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 012-2h12a2 2 0 012 2v7m-16 0v5a2 2 0 002 2h12a2 2 0 002-2v-5"
    stroke="currentColor"
    strokeWidth="1.8"
  />
);

/** Sidebar entry that routes, with an optional count bubble. */
function NavLink({
  to,
  label,
  icon,
  badge,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}) {
  return (
    <Link
      to={to}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-muted [&.active]:bg-indigo-50 [&.active]:font-medium [&.active]:text-indigo-700"
    >
      <svg className="h-4 w-4 opacity-70" viewBox="0 0 24 24" fill="none">
        {icon}
      </svg>
      {label}
      {badge ? (
        <span className="ml-auto min-w-[18px] rounded-full bg-indigo-600 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}
