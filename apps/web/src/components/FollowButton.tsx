import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MutableEntity } from "../lib/api.js";
import { cn } from "../lib/utils.js";

export function useFollowing(entityType: MutableEntity, entityId: string) {
  const { data: follows = [] } = useQuery({ queryKey: ["follows"], queryFn: api.getFollows });
  return follows.some((f) => f.entityType === entityType && f.entityId === entityId);
}

export function useToggleFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entityType, entityId, following }: { entityType: MutableEntity; entityId: string; following: boolean }) =>
      following ? api.unfollowEntity(entityType, entityId) : api.followEntity(entityType, entityId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["follows"] }),
  });
}

/**
 * Row 77: follow / unfollow a task, doc or project to get its activity in
 * the inbox. Assignment and @mentions follow you automatically.
 */
export function FollowButton({ entityType, entityId, compact }: { entityType: MutableEntity; entityId: string; compact?: boolean }) {
  const following = useFollowing(entityType, entityId);
  const toggle = useToggleFollow();
  const what = entityType === "document" ? "doc" : entityType;
  return (
    <button
      type="button"
      onClick={() => toggle.mutate({ entityType, entityId, following })}
      title={following ? `Stop following this ${what}` : `Follow this ${what} - its activity lands in your inbox`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition",
        following ? "bg-indigo-50 text-indigo-700 hover:bg-indigo-100" : "text-slate-600 hover:bg-muted",
      )}
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill={following ? "currentColor" : "none"}>
        <path d="M18 8a6 6 0 10-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9z" stroke="currentColor" strokeWidth="1.8" />
      </svg>
      {!compact && (following ? "Following" : "Follow")}
    </button>
  );
}
