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

  @Post("channels/:id/messages")
  async send(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: { body: string },
  ) {
    const msg = await this.chat.sendMessage(auth.orgId, id, auth.userId, body.body);
    this.gateway.broadcast(id, msg);
    return msg;
  }

  @Post("channels")
  @Roles("owner", "admin", "member")
  create(@Auth() auth: AuthContext, @Body() body: { name: string }) {
    return this.chat.createChannel(auth.orgId, auth.userId, body.name);
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

  /** Find-or-create the DM with one person. */
  @Post("dm")
  dm(@Auth() auth: AuthContext, @Body() body: { userId: string }) {
    return this.chat.openDm(auth.orgId, auth.userId, body.userId);
  }
}
