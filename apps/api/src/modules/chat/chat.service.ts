import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { channels, channelMembers, memberships, messages } from "../../db/schema.js";

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

    return rows.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      topic: c.topic,
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

  private async membersOf(channelId: string) {
    const rows = await this.db.query.channelMembers.findMany({
      where: eq(channelMembers.channelId, channelId),
      with: { user: true },
    });
    return rows.map((m) => ({ id: m.user.id, name: m.user.name, avatarUrl: m.user.avatarUrl }));
  }

  async listMessages(orgId: string, channelId: string, userId: string) {
    await this.assertMember(channelId, userId);
    const rows = await this.db.query.messages.findMany({
      where: and(eq(messages.organizationId, orgId), eq(messages.channelId, channelId)),
      with: { author: true },
      orderBy: (m) => [asc(m.createdAt)],
      limit: 200,
    });
    return rows.map(this.shape);
  }

  async sendMessage(orgId: string, channelId: string, userId: string, body: string) {
    await this.assertMember(channelId, userId);
    const [row] = await this.db
      .insert(messages)
      .values({ organizationId: orgId, channelId, authorId: userId, body })
      .returning();
    const withAuthor = await this.db.query.messages.findFirst({
      where: eq(messages.id, row!.id),
      with: { author: true },
    });
    return this.shape(withAuthor!);
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
    author: { id: string; name: string; avatarUrl: string | null };
  }) {
    return {
      id: m.id,
      channelId: m.channelId,
      body: m.body,
      createdAt: m.createdAt,
      author: { id: m.author.id, name: m.author.name, avatarUrl: m.author.avatarUrl },
    };
  }
}
