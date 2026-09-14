import type { ReactNode } from "react";
import type { Member, Priority } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/** Row 107: the palette an admin can pick from. Literal class names so Tailwind keeps them. */
export const PRIORITY_PALETTE: Record<string, { color: string; text: string; swatch: string }> = {
  red: { color: "bg-red-500", text: "text-red-600", swatch: "#ef4444" },
  orange: { color: "bg-orange-500", text: "text-orange-600", swatch: "#f97316" },
  amber: { color: "bg-amber-500", text: "text-amber-600", swatch: "#f59e0b" },
  yellow: { color: "bg-yellow-400", text: "text-yellow-600", swatch: "#facc15" },
  green: { color: "bg-green-500", text: "text-green-600", swatch: "#22c55e" },
  teal: { color: "bg-teal-500", text: "text-teal-600", swatch: "#14b8a6" },
  blue: { color: "bg-blue-500", text: "text-blue-600", swatch: "#3b82f6" },
  indigo: { color: "bg-indigo-500", text: "text-indigo-600", swatch: "#6366f1" },
  purple: { color: "bg-purple-500", text: "text-purple-600", swatch: "#a855f7" },
  pink: { color: "bg-pink-500", text: "text-pink-600", swatch: "#ec4899" },
  slate: { color: "bg-slate-400", text: "text-slate-500", swatch: "#94a3b8" },
};
export const PRIORITY_DEFAULTS: Record<Priority, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "red" },
  high: { label: "High", color: "orange" },
  normal: { label: "Normal", color: "blue" },
  low: { label: "Low", color: "slate" },
};
export type PriorityConfig = Partial<Record<Priority, { label: string; color: string }>>;

/**
 * Live registry read by every priority pill, picker and parser. The workspace's
 * config is applied once on load (Sidebar) and again when Settings saves it.
 */
export const PRIORITY: Record<Priority, { label: string; color: string; text: string; palette: string }> = {
  urgent: { label: "Urgent", ...PRIORITY_PALETTE.red!, palette: "red" },
  high: { label: "High", ...PRIORITY_PALETTE.orange!, palette: "orange" },
  normal: { label: "Normal", ...PRIORITY_PALETTE.blue!, palette: "blue" },
  low: { label: "Low", ...PRIORITY_PALETTE.slate!, palette: "slate" },
};
export function applyPriorityConfig(cfg: PriorityConfig | null | undefined) {
  for (const k of Object.keys(PRIORITY_DEFAULTS) as Priority[]) {
    const c = cfg?.[k] ?? PRIORITY_DEFAULTS[k];
    const pal = PRIORITY_PALETTE[c.color] ?? PRIORITY_PALETTE[PRIORITY_DEFAULTS[k].color]!;
    PRIORITY[k].label = c.label || PRIORITY_DEFAULTS[k].label;
    PRIORITY[k].color = pal.color;
    PRIORITY[k].text = pal.text;
    PRIORITY[k].palette = PRIORITY_PALETTE[c.color] ? c.color : PRIORITY_DEFAULTS[k].color;
  }
}

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
