import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { channels, channelMembers, messages } from "../../db/schema.js";

@Injectable()
export class ChatService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /** Channels the user belongs to, with members (client derives DM names). */
  async listChannels(orgId: string, userId: string) {
    const memberships = await this.db.query.channelMembers.findMany({
      where: eq(channelMembers.userId, userId),
    });
    const ids = memberships.map((m) => m.channelId);
    if (!ids.length) return [];

    const rows = await this.db.query.channels.findMany({
      where: and(eq(channels.organizationId, orgId), inArray(channels.id, ids)),
      with: { members: { with: { user: true } } },
      orderBy: (c) => [asc(c.createdAt)],
    });

    return rows.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      topic: c.topic,
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

  async createChannel(orgId: string, userId: string, name: string) {
    const [ch] = await this.db
      .insert(channels)
      .values({ organizationId: orgId, type: "channel", name, createdById: userId })
      .returning();
    await this.db.insert(channelMembers).values({
      channelId: ch!.id,
      userId,
      organizationId: orgId,
    });
    return ch;
  }

  /**
   * The DM between me and one other person — found if it exists, created if
   * not. DMs are unnamed; the client labels them with the other member.
   */
  async openDm(orgId: string, meId: string, otherId: string) {
    if (meId === otherId) throw new ForbiddenException("You cannot message yourself");
    const mine = await this.db.query.channelMembers.findMany({
      where: eq(channelMembers.userId, meId),
    });
    if (mine.length) {
      const candidates = await this.db.query.channels.findMany({
        where: and(
          eq(channels.organizationId, orgId),
          eq(channels.type, "dm"),
          inArray(channels.id, mine.map((m) => m.channelId)),
        ),
        with: { members: true },
      });
      const existing = candidates.find(
        (c) => c.members.length === 2 && c.members.some((m) => m.userId === otherId),
      );
      if (existing) return { id: existing.id, created: false };
    }

    const [ch] = await this.db
      .insert(channels)
      .values({ organizationId: orgId, type: "dm", name: null, createdById: meId })
      .returning();
    await this.db.insert(channelMembers).values([
      { channelId: ch!.id, userId: meId, organizationId: orgId },
      { channelId: ch!.id, userId: otherId, organizationId: orgId },
    ]);
    return { id: ch!.id, created: true };
  }

  /** Any org member can join a named channel; DMs are invite-only by nature. */
  async join(orgId: string, channelId: string, userId: string) {
    const ch = await this.db.query.channels.findFirst({
      where: and(eq(channels.id, channelId), eq(channels.organizationId, orgId)),
    });
    if (!ch || ch.type !== "channel") throw new ForbiddenException("Channel not found");
    await this.db
      .insert(channelMembers)
      .values({ channelId, userId, organizationId: orgId })
      .onConflictDoNothing();
    return { id: channelId, joined: true };
  }

  /** Every named channel in the org, with whether I'm in it — for "browse channels". */
  async browse(orgId: string, userId: string) {
    const rows = await this.db.query.channels.findMany({
      where: and(eq(channels.organizationId, orgId), eq(channels.type, "channel")),
      with: { members: true },
      orderBy: (c) => [asc(c.createdAt)],
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      topic: c.topic,
      memberCount: c.members.length,
      joined: c.members.some((m) => m.userId === userId),
    }));
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
