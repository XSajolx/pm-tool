import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, eq, gt, inArray, isNull, max, ne, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { channels, channelMembers, memberships, messages, notificationPreferences, notifications } from "../../db/schema.js";

/** "Website Redesign" → "website-redesign" (channel names are slugs). */
function slug(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "channel"
  );
}

@Injectable()
export class ChatService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /**
   * Channels the user belongs to, with members (client derives DM names).
   * Row 39: project channels carry their project so the list can group them.
   */
  async listChannels(orgId: string, userId: string) {
    const mine = await this.db.query.channelMembers.findMany({
      where: eq(channelMembers.userId, userId),
    });
    const ids = mine.map((m) => m.channelId);
    if (!ids.length) return [];

    const rows = await this.db.query.channels.findMany({
      where: and(eq(channels.organizationId, orgId), inArray(channels.id, ids)),
      with: {
        members: { with: { user: true } },
        project: { columns: { id: true, name: true, color: true, archivedAt: true } },
      },
      orderBy: (c) => [asc(c.createdAt)],
    });

    // Row 42: unread = other people's messages newer than my last-read mark.
    const unread = await this.db
      .select({ channelId: messages.channelId, n: count() })
      .from(messages)
      .innerJoin(channelMembers, and(eq(channelMembers.channelId, messages.channelId), eq(channelMembers.userId, userId)))
      .where(and(inArray(messages.channelId, ids), ne(messages.authorId, userId), or(isNull(channelMembers.lastReadAt), gt(messages.createdAt, channelMembers.lastReadAt))))
      .groupBy(messages.channelId);
    const unreadBy = new Map(unread.map((u) => [u.channelId, Number(u.n)]));
    const lastReadBy = new Map(mine.map((m) => [m.channelId, m.lastReadAt]));

    return rows.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      topic: c.topic,
      unreadCount: unreadBy.get(c.id) ?? 0,
      lastReadAt: lastReadBy.get(c.id) ?? null,
      isPrivate: c.isPrivate,
      projectId: c.projectId,
      project: c.project ? { id: c.project.id, name: c.project.name, color: c.project.color, archived: Boolean(c.project.archivedAt) } : null,
      members: c.members.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
      })),
    }));
  }

  /** Membership check without throwing — used by the WS gateway on room join. */
  async isMember(channelId: string, userId: string) {
    const m = await this.db.query.channelMembers.findFirst({
      where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
    });
    return Boolean(m);
  }

  private async assertMember(channelId: string, userId: string) {
    const m = await this.db.query.channelMembers.findFirst({
      where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
    });
    if (!m) throw new ForbiddenException("Not a member of this channel");
  }

  private async channel(orgId: string, channelId: string) {
    const ch = await this.db.query.channels.findFirst({
      where: and(eq(channels.id, channelId), eq(channels.organizationId, orgId)),
    });
    if (!ch) throw new NotFoundException("Channel not found");
    return ch;
  }

  /** Only people who belong to this org can be put in a channel. */
  private async orgUserIds(orgId: string, userIds: string[]) {
    const uniq = [...new Set(userIds)];
    if (!uniq.length) return [];
    const rows = await this.db.query.memberships.findMany({
      where: and(eq(memberships.organizationId, orgId), inArray(memberships.userId, uniq)),
      columns: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Row 42: "I've seen everything up to now" — the same mark every device reads. */
  async markRead(orgId: string, channelId: string, userId: string) {
    const lastReadAt = new Date();
    const [row] = await this.db
      .update(channelMembers)
      .set({ lastReadAt })
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId), eq(channelMembers.organizationId, orgId)))
      .returning({ channelId: channelMembers.channelId });
    if (!row) throw new ForbiddenException("Not a member of this channel");
    return { channelId, lastReadAt };
  }

  async memberIds(channelId: string) {
    const rows = await this.db.query.channelMembers.findMany({ where: eq(channelMembers.channelId, channelId), columns: { userId: true } });
    return rows.map((r) => r.userId);
  }

  private async membersOf(channelId: string) {
    const rows = await this.db.query.channelMembers.findMany({
      where: eq(channelMembers.channelId, channelId),
      with: { user: true },
    });
    return rows.map((m) => ({ id: m.user.id, name: m.user.name, avatarUrl: m.user.avatarUrl }));
  }

  /**
   * Top-level messages only (row 40: replies live in threads), each with its
   * reply count and the time of the latest reply so the row can show "3 replies".
   */
  async listMessages(orgId: string, channelId: string, userId: string) {
    await this.assertMember(channelId, userId);
    const rows = await this.db.query.messages.findMany({
      where: and(eq(messages.organizationId, orgId), eq(messages.channelId, channelId), isNull(messages.parentMessageId)),
      with: { author: true },
      orderBy: (m) => [asc(m.createdAt)],
      limit: 200,
    });
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await this.db
          .select({ parentMessageId: messages.parentMessageId, n: count(), last: max(messages.createdAt) })
          .from(messages)
          .where(and(eq(messages.channelId, channelId), inArray(messages.parentMessageId, ids)))
          .groupBy(messages.parentMessageId)
      : [];
    const byParent = new Map(counts.map((c) => [c.parentMessageId!, c]));
    return rows.map((m) => {
      const c = byParent.get(m.id);
      return { ...this.shape(m), replyCount: Number(c?.n ?? 0), lastReplyAt: c?.last ?? null };
    });
  }

  /** Row 40: the first message of a thread plus its replies, oldest first. */
  async listReplies(orgId: string, channelId: string, messageId: string, userId: string) {
    await this.assertMember(channelId, userId);
    const root = await this.db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.channelId, channelId), eq(messages.organizationId, orgId)),
      with: { author: true },
    });
    if (!root) throw new NotFoundException("Message not found");
    const replies = await this.db.query.messages.findMany({
      where: and(eq(messages.channelId, channelId), eq(messages.parentMessageId, messageId)),
      with: { author: true },
      orderBy: (m) => [asc(m.createdAt)],
    });
    return { root: { ...this.shape(root), replyCount: replies.length, lastReplyAt: replies.at(-1)?.createdAt ?? null }, replies: replies.map(this.shape) };
  }

  /** A channel message, or — with `parentMessageId` — a reply in that message's thread (one level deep). */
  async sendMessage(orgId: string, channelId: string, userId: string, body: string, parentMessageId?: string | null) {
    await this.assertMember(channelId, userId);
    if (!body?.trim()) throw new BadRequestException("Message can't be empty");
    if (parentMessageId) {
      const parent = await this.db.query.messages.findFirst({
        where: and(eq(messages.id, parentMessageId), eq(messages.channelId, channelId)),
        columns: { id: true, parentMessageId: true },
      });
      if (!parent) throw new BadRequestException("That message isn't in this channel");
      if (parent.parentMessageId) throw new BadRequestException("Reply to the thread's first message");
    }
    const [row] = await this.db
      .insert(messages)
      .values({ organizationId: orgId, channelId, authorId: userId, body, parentMessageId: parentMessageId ?? null })
      .returning();
    const withAuthor = await this.db.query.messages.findFirst({
      where: eq(messages.id, row!.id),
      with: { author: true },
    });
    return { ...this.shape(withAuthor!), replyCount: 0, lastReplyAt: null };
  }

  /**
   * A named channel. Private channels (row 39) are invite-only: they don't show
   * up in Browse and can't be joined, only added to by an existing member.
   */
  async createChannel(orgId: string, userId: string, input: { name: string; isPrivate?: boolean; memberIds?: string[] }) {
    const name = slug(input.name ?? "");
    if (!name || name === "channel") throw new BadRequestException("Channel name is required");
    const [ch] = await this.db
      .insert(channels)
      .values({ organizationId: orgId, type: "channel", name, isPrivate: Boolean(input.isPrivate), createdById: userId })
      .returning();
    const ids = await this.orgUserIds(orgId, [userId, ...(input.memberIds ?? [])]);
    await this.db
      .insert(channelMembers)
      .values(ids.map((id) => ({ channelId: ch!.id, userId: id, organizationId: orgId })))
      .onConflictDoNothing();
    return ch;
  }

  /** The 1:1 DM with one person — found if it exists, created if not. */
  openDm(orgId: string, meId: string, otherId: string) {
    return this.openGroupDm(orgId, meId, [otherId]);
  }

  /**
   * Row 39: a DM with one or more people. The conversation is identified by its
   * exact member set, so opening the same group twice lands in the same place.
   * DMs are unnamed; the client labels them with the other members.
   */
  async openGroupDm(orgId: string, meId: string, userIds: string[]) {
    const want = new Set([meId, ...userIds]);
    if (want.size < 2) throw new BadRequestException("Pick at least one other person");
    const ids = await this.orgUserIds(orgId, [...want]);
    if (ids.length !== want.size) throw new BadRequestException("Someone you picked isn't in this workspace");
    const key = [...want].sort().join(",");

    const mine = await this.db.query.channelMembers.findMany({ where: eq(channelMembers.userId, meId) });
    if (mine.length) {
      const candidates = await this.db.query.channels.findMany({
        where: and(
          eq(channels.organizationId, orgId),
          eq(channels.type, "dm"),
          inArray(
            channels.id,
            mine.map((m) => m.channelId),
          ),
        ),
        with: { members: true },
      });
      const existing = candidates.find((c) => c.members.map((m) => m.userId).sort().join(",") === key);
      if (existing) return { id: existing.id, created: false };
    }

    const [ch] = await this.db
      .insert(channels)
      .values({ organizationId: orgId, type: "dm", name: null, createdById: meId })
      .returning();
    await this.db.insert(channelMembers).values([...want].map((userId) => ({ channelId: ch!.id, userId, organizationId: orgId })));
    return { id: ch!.id, created: true };
  }

  /**
   * Row 41: who a message addresses. Only people who can see the channel count:
   * explicit picks from the composer, "@Full Name" / "@First" typed in the
   * body, plus the @channel and @here broadcasts.
   */
  private async resolveMentions(channelId: string, body: string, explicitIds: string[], actorId: string) {
    const rows = await this.db.query.channelMembers.findMany({
      where: eq(channelMembers.channelId, channelId),
      with: { user: { columns: { id: true, name: true } } },
    });
    const members = rows.map((m) => ({ id: m.user.id, name: m.user.name }));
    const memberIds = new Set(members.map((m) => m.id));
    const everyone = /(^|\s)@channel(?![\w-])/i.test(body);
    const here = /(^|\s)@here(?![\w-])/i.test(body);
    const direct = new Set<string>();
    for (const id of explicitIds) if (memberIds.has(id)) direct.add(id);
    const lower = body.toLowerCase();
    for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
      const full = `@${m.name.toLowerCase()}`;
      const first = `@${m.name.split(" ")[0]!.toLowerCase()}`;
      if (lower.includes(full) || lower.includes(first)) direct.add(m.id);
    }
    direct.delete(actorId);
    return { members, direct: [...direct], everyone, here };
  }

  /**
   * Row 41: write inbox notifications for a message's mentions and return the
   * rows so the caller can push them live. Direct mentions win over @channel /
   * @here; @here reaches only members who are online right now. Honours each
   * receiver's "mention" preference.
   */
  async notifyMentions(
    orgId: string,
    actorId: string,
    channelId: string,
    msg: { id: string; body: string; parentMessageId: string | null },
    explicitIds: string[],
    online: Set<string>,
  ) {
    const ch = await this.channel(orgId, channelId);
    const { members, direct, everyone, here } = await this.resolveMentions(channelId, msg.body, explicitIds, actorId);
    const receivers = new Map<string, "you" | "channel" | "here">();
    if (everyone) for (const m of members) receivers.set(m.id, "channel");
    if (here) for (const m of members) if (online.has(m.id)) receivers.set(m.id, "here");
    for (const id of direct) receivers.set(id, "you");
    receivers.delete(actorId);
    if (!receivers.size) return [];

    const ids = [...receivers.keys()];
    const prefs = await this.db
      .select()
      .from(notificationPreferences)
      .where(and(eq(notificationPreferences.organizationId, orgId), inArray(notificationPreferences.userId, ids)));
    const muted = new Set(prefs.filter((p) => !p.mention).map((p) => p.userId));
    const actor = members.find((m) => m.id === actorId);
    const where = ch.type === "dm" ? "a direct message" : `#${ch.name}`;
    const excerpt = msg.body.length > 140 ? `${msg.body.slice(0, 137)}…` : msg.body;

    const values = ids
      .filter((id) => !muted.has(id))
      .map((receiverId) => {
        const how = receivers.get(receiverId)!;
        return {
          organizationId: orgId,
          receiverId,
          triggeredById: actorId,
          entityType: "message",
          entityId: msg.id,
          verb: "mentioned",
          category: "primary",
          title: how === "you" ? `${actor?.name ?? "Someone"} mentioned you in ${where}` : `${actor?.name ?? "Someone"} mentioned @${how} in ${where}`,
          body: `${how === "you" ? "" : `@${how} `}in ${where}: ${excerpt}`,
          data: { channelId, messageId: msg.id, parentMessageId: msg.parentMessageId, channelName: ch.name, how },
        };
      });
    if (!values.length) return [];
    return this.db.insert(notifications).values(values).returning();
  }

  /** Any org member can join a public named channel. Private and project channels are invite-only. */
  async join(orgId: string, channelId: string, userId: string) {
    const ch = await this.channel(orgId, channelId);
    if (ch.type !== "channel") throw new ForbiddenException("Channel not found");
    if (ch.projectId) throw new ForbiddenException("Join the project team to get into its channel");
    if (ch.isPrivate) throw new ForbiddenException("This channel is invite-only");
    await this.db
      .insert(channelMembers)
      .values({ channelId, userId, organizationId: orgId })
      .onConflictDoNothing();
    return { id: channelId, joined: true };
  }

  /** Row 39: an existing member invites people into a named channel. */
  async addMembers(orgId: string, channelId: string, byUserId: string, userIds: string[]) {
    const ch = await this.channel(orgId, channelId);
    if (ch.type === "dm") throw new BadRequestException("Start a new group message to add people");
    if (ch.projectId) throw new BadRequestException("Project channel members come from the project team");
    await this.assertMember(channelId, byUserId);
    const ids = await this.orgUserIds(orgId, userIds);
    if (ids.length) {
      await this.db
        .insert(channelMembers)
        .values(ids.map((userId) => ({ channelId, userId, organizationId: orgId })))
        .onConflictDoNothing();
    }
    return this.membersOf(channelId);
  }

  /** Leave a named channel. Project channels follow the team; DMs can't be left. */
  async leave(orgId: string, channelId: string, userId: string) {
    const ch = await this.channel(orgId, channelId);
    if (ch.type === "dm") throw new BadRequestException("Direct messages can't be left");
    if (ch.projectId) throw new BadRequestException("Leave the project team to leave its channel");
    await this.db.delete(channelMembers).where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
    return { id: channelId, left: true };
  }

  /** Public named channels in the org (plus private ones I'm already in), with a joined flag. */
  async browse(orgId: string, userId: string) {
    const rows = await this.db.query.channels.findMany({
      where: and(eq(channels.organizationId, orgId), eq(channels.type, "channel")),
      with: { members: true },
      orderBy: (c) => [asc(c.createdAt)],
    });
    return rows
      .map((c) => ({
        id: c.id,
        name: c.name,
        topic: c.topic,
        isPrivate: c.isPrivate,
        projectId: c.projectId,
        memberCount: c.members.length,
        joined: c.members.some((m) => m.userId === userId),
      }))
      .filter((c) => c.joined || (!c.isPrivate && !c.projectId));
  }

  /**
   * Row 39: every project has one channel and its members are exactly the
   * project team. Called whenever the team or the project name changes.
   */
  async ensureProjectChannel(orgId: string, project: { id: string; name: string }, memberIds: string[]) {
    const name = slug(project.name);
    let ch = await this.db.query.channels.findFirst({
      where: and(eq(channels.organizationId, orgId), eq(channels.projectId, project.id)),
    });
    if (!ch) {
      [ch] = await this.db
        .insert(channels)
        .values({ organizationId: orgId, type: "channel", name, isPrivate: true, projectId: project.id })
        .returning();
    } else if (ch.name !== name) {
      await this.db.update(channels).set({ name, updatedAt: new Date() }).where(eq(channels.id, ch.id));
    }
    const want = new Set(await this.orgUserIds(orgId, memberIds));
    const current = await this.db.query.channelMembers.findMany({ where: eq(channelMembers.channelId, ch!.id) });
    const have = new Set(current.map((m) => m.userId));
    const add = [...want].filter((id) => !have.has(id));
    const drop = [...have].filter((id) => !want.has(id));
    if (add.length) {
      await this.db
        .insert(channelMembers)
        .values(add.map((userId) => ({ channelId: ch!.id, userId, organizationId: orgId })))
        .onConflictDoNothing();
    }
    if (drop.length) {
      await this.db.delete(channelMembers).where(and(eq(channelMembers.channelId, ch!.id), inArray(channelMembers.userId, drop)));
    }
    return ch!;
  }

  private shape(m: {
    id: string;
    channelId: string;
    body: string;
    createdAt: Date;
    parentMessageId: string | null;
    author: { id: string; name: string; avatarUrl: string | null };
  }) {
    return {
      id: m.id,
      channelId: m.channelId,
      body: m.body,
      createdAt: m.createdAt,
      parentMessageId: m.parentMessageId,
      author: { id: m.author.id, name: m.author.name, avatarUrl: m.author.avatarUrl },
    };
  }
}
