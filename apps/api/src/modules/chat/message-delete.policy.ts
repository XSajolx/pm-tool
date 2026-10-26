import type { Role } from "../auth/auth.types.js";

/** Authors may take back their own message for this long; moderators have no limit. */
export const OWN_DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

type Actor = { userId: string; role: Role };
type ChannelFacts = { type: "channel" | "dm"; createdById: string | null; projectLeadId: string | null };

/**
 * Who may remove anyone's message in a channel: workspace owners and admins
 * everywhere (DMs included), the creator of a named channel, and the lead of
 * the project a project channel belongs to.
 */
export function canModerateChannel(actor: Actor, ch: ChannelFacts) {
  if (actor.role === "owner" || actor.role === "admin") return true;
  if (ch.type === "dm") return false;
  if (ch.projectLeadId) return ch.projectLeadId === actor.userId;
  return ch.createdById === actor.userId;
}

export function canDeleteMessage(
  actor: Actor,
  ch: ChannelFacts,
  msg: { authorId: string; kind: "user" | "system"; createdAt: Date },
  now = new Date(),
): { ok: true; as: "author" | "moderator" } | { ok: false; reason: string } {
  if (canModerateChannel(actor, ch)) return { ok: true, as: "moderator" };
  if (msg.kind !== "user" || msg.authorId !== actor.userId) return { ok: false, reason: "You can only delete your own messages" };
  if (now.getTime() - msg.createdAt.getTime() > OWN_DELETE_WINDOW_MS) return { ok: false, reason: "Messages can only be deleted within 24 hours of sending" };
  return { ok: true, as: "author" };
}
