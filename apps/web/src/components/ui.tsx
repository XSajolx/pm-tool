import type { ReactNode } from "react";
import type { Member, Priority } from "../lib/api.js";
import { cn } from "../lib/utils.js";

export const PRIORITY: Record<Priority, { label: string; color: string; text: string }> = {
  urgent: { label: "Urgent", color: "bg-red-500", text: "text-red-600" },
  high: { label: "High", color: "bg-orange-500", text: "text-orange-600" },
  normal: { label: "Normal", color: "bg-blue-500", text: "text-blue-600" },
  low: { label: "Low", color: "bg-slate-400", text: "text-slate-500" },
};

export function Avatar({ user, size = 22 }: { user: Member; size?: number }) {
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-white bg-indigo-100 font-medium text-indigo-700"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title={user.name}
    >
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt={user.name} className="h-full w-full rounded-full" />
      ) : (
        initials
      )}
    </span>
  );
}

export function StatusPill({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ background: `${color}1a`, color }}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}

export function PriorityFlag({ priority }: { priority: Priority | null }) {
  if (!priority) return <span className="text-xs text-muted-foreground">—</span>;
  const p = PRIORITY[priority];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", p.text)}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M5 3v18M5 4h11l-2 3 2 3H5" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>
      {p.label}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost";
  className?: string;
  type?: "button" | "submit";
}) {
  const variants = {
    default: "border border-border bg-white hover:bg-muted text-slate-700",
    primary: "bg-indigo-600 text-white hover:bg-indigo-700",
    ghost: "text-slate-600 hover:bg-muted",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function AvatarStack({ users }: { users: Member[] }) {
  if (!users.length) return null;
  return (
    <div className="flex -space-x-1.5">
      {users.slice(0, 3).map((u) => (
        <Avatar key={u.id} user={u} />
      ))}
      {users.length > 3 && (
        <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border border-white bg-slate-200 text-[10px] font-medium text-slate-600">
          +{users.length - 3}
        </span>
      )}
    </div>
  );
}
