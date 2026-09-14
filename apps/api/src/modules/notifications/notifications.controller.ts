import { Body, Controller, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { NotificationsService, type InboxTab } from "./notifications.service.js";
import { RemindersService } from "./reminders.service.js";
import { Auth } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const preferencesSchema = z.object({
  propertyChange: z.boolean().optional(),
  statusChange: z.boolean().optional(),
  comment: z.boolean().optional(),
  mention: z.boolean().optional(),
  taskCompleted: z.boolean().optional(),
});

const snoozeSchema = z.object({ until: z.string().datetime() });
const tabSchema = z.enum(["all", "mentions", "assigned", "approvals", "alerts", "replies", "later", "cleared"]);
const typedTab = z.enum(["all", "mentions", "assigned", "approvals", "alerts"]);
const clearSchema = z.object({ tab: typedTab.optional() });

/**
 * The inbox. Everything is implicitly scoped to the caller — there is no way to
 * read or mutate someone else's notifications, because the receiver id always
 * comes from the verified token rather than the request body.
 */
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly reminders: RemindersService,
  ) {}

  /** Row 72: run the due-date reminder sweep now (it also runs every 5 minutes). */
  @Post("reminders/sweep")
  sweepReminders() {
    return this.reminders.sweep();
  }

  /** `?tab=` picks all (default) / mentions / assigned / approvals / alerts / replies / later / cleared. */
  @Get()
  list(@Auth() auth: AuthContext, @Query("tab") tab?: string) {
    const parsed = tabSchema.safeParse(tab);
    return this.notifications.list(
      auth.orgId,
      auth.userId,
      (parsed.success ? parsed.data : "all") as InboxTab,
    );
  }

  /** Cheap enough to poll; also pushed live over the socket as notification:new. */
  @Get("unread-count")
  unreadCount(@Auth() auth: AuthContext) {
    return this.notifications.unreadCounts(auth.orgId, auth.userId);
  }

  @Get("preferences")
  preferences(@Auth() auth: AuthContext) {
    return this.notifications.getPreferences(auth.orgId, auth.userId);
  }

  @Patch("preferences")
  @UsePipes(new ZodValidationPipe(preferencesSchema))
  updatePreferences(
    @Auth() auth: AuthContext,
    @Body() dto: z.infer<typeof preferencesSchema>,
  ) {
    return this.notifications.updatePreferences(auth.orgId, auth.userId, dto);
  }

  /** Row 71: mark everything read - optionally just one tab. */
  @Post("read-all")
  @UsePipes(new ZodValidationPipe(clearSchema))
  markAllRead(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof clearSchema>) {
    return this.notifications.markAllRead(auth.orgId, auth.userId, dto.tab);
  }

  /** Archive everything live — optionally just one tab. */
  @Post("clear-all")
  @UsePipes(new ZodValidationPipe(clearSchema))
  clearAll(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof clearSchema>) {
    return this.notifications.clearAll(auth.orgId, auth.userId, dto.tab);
  }

  @Patch(":id/read")
  markRead(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.notifications.markRead(auth.orgId, auth.userId, id);
  }

  @Patch(":id/archive")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.notifications.archive(auth.orgId, auth.userId, id);
  }

  /** Brings a snoozed or cleared item back into the live inbox. */
  @Patch(":id/restore")
  restore(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.notifications.restore(auth.orgId, auth.userId, id);
  }

  /** The red flag. Toggles. */
  @Patch(":id/important")
  important(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.notifications.toggleImportant(auth.orgId, auth.userId, id);
  }

  @Patch(":id/snooze")
  @UsePipes(new ZodValidationPipe(snoozeSchema))
  snooze(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof snoozeSchema>,
  ) {
    return this.notifications.snooze(auth.orgId, auth.userId, id, new Date(dto.until));
  }
}
