import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MutableEntity } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/** Is this thread muted for me? Shared by the button and the inbox rows. */
export function useMuted(entityType: MutableEntity, entityId: string) {
  const { data: mutes = [] } = useQuery({ queryKey: ["mutes"], queryFn: api.getMutes });
  return mutes.some((m) => m.entityType === entityType && m.entityId === entityId);
}

export function useToggleMute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entityType, entityId, muted }: { entityType: MutableEntity; entityId: string; muted: boolean }) =>
      muted ? api.unmuteEntity(entityType, entityId) : api.muteEntity(entityType, entityId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mutes"] }),
  });
}

/**
 * Row 74: mute / unmute a task, doc or project thread. Muting silences every
 * notification about it (mentions included); a project mute covers its tasks,
 * docs and milestones.
 */
export function MuteButton({ entityType, entityId, compact }: { entityType: MutableEntity; entityId: string; compact?: boolean }) {
  const muted = useMuted(entityType, entityId);
  const toggle = useToggleMute();
  const what = entityType === "document" ? "doc" : entityType;
  return (
    <button
      type="button"
      onClick={() => toggle.mutate({ entityType, entityId, muted })}
      title={muted ? `Unmute this ${what}` : `Mute this ${what} - no notifications about it, mentions included`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition",
        muted ? "bg-amber-50 text-amber-800 hover:bg-amber-100" : "text-slate-500 hover:bg-muted hover:text-slate-700",
      )}
    >
      <span aria-hidden>{muted ? "🔕" : "🔔"}</span>
      {!compact && (muted ? "Muted" : "Mute")}
    </button>
  );
}
