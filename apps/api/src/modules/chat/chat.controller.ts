import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
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
    @Body() body: { body: string; parentMessageId?: string | null; mentionedUserIds?: string[]; attachmentIds?: string[] },
  ) {
    const msg = await this.chat.sendMessage(auth.orgId, id, auth.userId, body.body ?? "", body.parentMessageId, body.attachmentIds ?? []);
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

  /** Row 44: toggle an emoji reaction on a message; everyone in the channel sees it move. */
  @Post("channels/:id/messages/:messageId/reactions")
  @Roles("owner", "admin", "member")
  async react(@Auth() auth: AuthContext, @Param("id") id: string, @Param("messageId") messageId: string, @Body() body: { emoji: string }) {
    const res = await this.chat.react(auth.orgId, id, messageId, auth.userId, body.emoji);
    this.gateway.emitToChannel(id, "message:reaction", res);
    return res;
  }

  /* Row 46: pins + bookmarks */
  @Post("channels/:id/messages/:messageId/pin")
  @Roles("owner", "admin", "member")
  async pin(@Auth() auth: AuthContext, @Param("id") id: string, @Param("messageId") messageId: string) {
    const res = await this.chat.togglePin(auth.orgId, id, messageId, auth.userId);
    this.gateway.emitToChannel(id, "message:pin", res);
    return res;
  }

  @Get("channels/:id/pins")
  pins(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.chat.pins(auth.orgId, id, auth.userId);
  }

  @Post("channels/:id/bookmarks")
  @Roles("owner", "admin", "member")
  async addBookmark(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: { label: string; url: string }) {
    const res = await this.chat.addBookmark(auth.orgId, id, auth.userId, body);
    this.gateway.emitToChannel(id, "channel:bookmarks", { channelId: id });
    return res;
  }

  @Delete("channels/:id/bookmarks/:bookmarkId")
  @Roles("owner", "admin", "member")
  async removeBookmark(@Auth() auth: AuthContext, @Param("id") id: string, @Param("bookmarkId") bookmarkId: string) {
    const res = await this.chat.removeBookmark(auth.orgId, id, auth.userId, bookmarkId);
    this.gateway.emitToChannel(id, "channel:bookmarks", { channelId: id });
    return res;
  }

  /** Row 50: project channel activity feed on/off. */
  @Patch("channels/:id/activity-feed")
  @Roles("owner", "admin", "member")
  async activityFeed(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: { enabled: boolean }) {
    const res = await this.chat.setActivityFeed(auth.orgId, id, auth.userId, Boolean(body.enabled));
    this.gateway.emitToChannel(id, "channel:bookmarks", { channelId: id }); // same "refetch channels" hook
    return res;
  }

  /** Row 45: all messages / mentions only / muted — per person, per channel. */
  @Patch("channels/:id/notify")
  async notify(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: { notify: "all" | "mentions" | "muted" }) {
    if (!["all", "mentions", "muted"].includes(body.notify)) throw new BadRequestException("notify must be all, mentions or muted");
    const res = await this.chat.setNotify(auth.orgId, id, auth.userId, body.notify);
    // Other devices refetch their channel list (same hook the read mark uses).
    this.gateway.emitToUser(auth.userId, "chat:read", { channelId: id });
    return res;
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

  /** Row 49: search my channels. q + optional from/in/has=file/after/before. */
  @Get("search")
  search(
    @Auth() auth: AuthContext,
    @Query("q") q?: string,
    @Query("from") from?: string,
    @Query("in") channelId?: string,
    @Query("has") has?: string,
    @Query("after") after?: string,
    @Query("before") before?: string,
  ) {
    return this.chat.search(auth.orgId, auth.userId, { q, from, in: channelId, hasFile: has === "file", after, before });
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
