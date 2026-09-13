import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ChatService } from "./chat.service.js";
import { ChatGateway } from "./chat.gateway.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

@Controller("chat")
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly gateway: ChatGateway,
  ) {}

  @Get("channels")
  channels(@Auth() auth: AuthContext) {
    return this.chat.listChannels(auth.orgId, auth.userId);
  }

  @Get("channels/:id/messages")
  messages(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.chat.listMessages(auth.orgId, id, auth.userId);
  }

  /** Row 40: a thread — the root message and its replies. */
  @Get("channels/:id/messages/:messageId/replies")
  replies(@Auth() auth: AuthContext, @Param("id") id: string, @Param("messageId") messageId: string) {
    return this.chat.listReplies(auth.orgId, id, messageId, auth.userId);
  }

  @Post("channels/:id/messages")
  async send(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: { body: string; parentMessageId?: string | null; mentionedUserIds?: string[] },
  ) {
    const msg = await this.chat.sendMessage(auth.orgId, id, auth.userId, body.body, body.parentMessageId);
    // Replies are broadcast too; the client routes them into the open thread.
    this.gateway.broadcast(id, msg);
    // Row 41: @mentions land in the inbox and are pushed live to whoever is online.
    const rows = await this.chat.notifyMentions(auth.orgId, auth.userId, id, msg, body.mentionedUserIds ?? [], this.gateway.onlineUserIds());
    for (const row of rows) this.gateway.emitToUser(row.receiverId, "notification:new", row);
    // Row 42: nudge every other member's devices so their unread badges move
    // even when they aren't looking at this channel.
    for (const userId of await this.chat.memberIds(id)) {
      if (userId !== auth.userId) this.gateway.emitToUser(userId, "chat:unread", { channelId: id, messageId: msg.id });
    }
    return msg;
  }

  /** Row 42: mark the channel read up to now; other open tabs/devices are told. */
  @Post("channels/:id/read")
  async read(@Auth() auth: AuthContext, @Param("id") id: string) {
    const res = await this.chat.markRead(auth.orgId, id, auth.userId);
    this.gateway.emitToUser(auth.userId, "chat:read", res);
    return res;
  }

  @Post("channels")
  @Roles("owner", "admin", "member")
  create(@Auth() auth: AuthContext, @Body() body: { name: string; isPrivate?: boolean; memberIds?: string[] }) {
    return this.chat.createChannel(auth.orgId, auth.userId, body);
  }

  /** Row 39: invite people into a named channel (any member can). */
  @Post("channels/:id/members")
  @Roles("owner", "admin", "member")
  addMembers(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: { userIds: string[] }) {
    return this.chat.addMembers(auth.orgId, id, auth.userId, body.userIds ?? []);
  }

  @Post("channels/:id/leave")
  leave(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.chat.leave(auth.orgId, id, auth.userId);
  }

  /** All named channels with a joined flag — the "browse" list. */
  @Get("browse")
  browse(@Auth() auth: AuthContext) {
    return this.chat.browse(auth.orgId, auth.userId);
  }

  @Post("channels/:id/join")
  join(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.chat.join(auth.orgId, id, auth.userId);
  }

  /** Find-or-create the DM with one person, or the group DM with several (row 39). */
  @Post("dm")
  dm(@Auth() auth: AuthContext, @Body() body: { userId?: string; userIds?: string[] }) {
    const ids = body.userIds ?? (body.userId ? [body.userId] : []);
    return this.chat.openGroupDm(auth.orgId, auth.userId, ids);
  }
}
