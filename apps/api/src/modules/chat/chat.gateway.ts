import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import type { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service.js";
import { TokenService } from "../auth/token.service.js";
import { ChatService } from "./chat.service.js";

/** What we hang off the socket once its token checks out. */
interface SocketIdentity {
  userId: string;
  name: string;
}

/**
 * Real-time transport for chat. Attaches to the same HTTP server (port 3333) at
 * /socket.io. Writes still go through the REST controller so the DB stays the
 * source of truth; this only fans out the result.
 *
 * Auth: the client passes its Supabase access token in the connection handshake
 * (`io(url, { auth: { token } })`). An unverified socket is disconnected before
 * it can join anything, and `join` additionally checks channel membership — a
 * valid token for one user must not let them subscribe to someone else's DM.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);
  private readonly identities = new Map<string, SocketIdentity>();

  @WebSocketServer() server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly chat: ChatService,
  ) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const claims = await this.tokens.verify(token);
      const user = await this.auth.resolveUser(claims);
      this.identities.set(client.id, { userId: user.id, name: user.name });
      // Personal room: lets any service push to a person without knowing their
      // socket id, and survives reconnects and multiple open tabs.
      void client.join(userRoom(user.id));
    } catch {
      this.logger.debug(`socket ${client.id} rejected: bad token`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.identities.delete(client.id);
  }

  @SubscribeMessage("join")
  async join(@ConnectedSocket() client: Socket, @MessageBody() channelId: string) {
    const me = this.identities.get(client.id);
    if (!me) return { error: "unauthorized" };
    if (!(await this.chat.isMember(channelId, me.userId))) {
      return { error: "forbidden" };
    }
    void client.join(channelId);
    return { joined: channelId };
  }

  @SubscribeMessage("leave")
  leave(@ConnectedSocket() client: Socket, @MessageBody() channelId: string) {
    void client.leave(channelId);
  }

  /** Row 41: everyone with at least one open socket — the audience for @here. */
  onlineUserIds() {
    return new Set([...this.identities.values()].map((i) => i.userId));
  }

  /** Called by the controller after a message is persisted. */
  broadcast(channelId: string, message: unknown) {
    this.server.to(channelId).emit("message:new", message);
  }

  /** Any other channel-scoped event (reactions, edits…) to everyone viewing it. */
  emitToChannel(channelId: string, event: string, payload: unknown) {
    this.server.to(channelId).emit(event, payload);
  }

  /**
   * Push to one person across all their open tabs. Used by NotificationsService;
   * a no-op if they have nothing open, since the row is already in the DB and
   * the inbox will pick it up on next load.
   */
  emitToUser(userId: string, event: string, payload: unknown) {
    this.server.to(userRoom(userId)).emit(event, payload);
  }
}

function userRoom(userId: string) {
  return `user:${userId}`;
}
