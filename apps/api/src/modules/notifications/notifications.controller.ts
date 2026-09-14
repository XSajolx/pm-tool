import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { NOTIF_TYPES, NotificationsService, type InboxTab, type MutableEntity } from "./notifications.service.js";
import { RemindersService } from "./reminders.service.js";
import { DigestService } from "./digest.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import { ActivityService } from "../activity/activity.service.js";
import type { AuthContext } from "../auth/auth.types.js";

/** Row 73: `{ mention: { email: false }, reminders: { push: true } }` - any subset. */
const channelSchema = z.object({ inApp: z.boolean().optional(), email: z.boolean().optional(), push: z.boolean().optional() });
/** Row 76 */
const digestSchema = z.object({
  frequency: z.enum(["off", "daily", "weekly"]).optional(),
  hour: z.number().int().min(0).max(23).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  inApp: z.boolean().optional(),
  email: z.boolean().optional(),
});
/** Row 111 */
const quietSchema = z.object({
  enabled: z.boolean().optional(),
  start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  weekends: z.boolean().optional(),
  timezone: z.string().min(1).max(64).optional(),
});
const preferencesSchema = z.object({
  ...(Object.fromEntries(NOTIF_TYPES.map((t) => [t, channelSchema.optional()])) as Record<(typeof NOTIF_TYPES)[number], z.ZodOptional<typeof channelSchema>>),
  digest: digestSchema.optional(),
  quietHours: quietSchema.nullable().optional(),
});
const workspaceDefaultsSchema = z.object({
  channels: z.object(Object.fromEntries(NOTIF_TYPES.map((t) => [t, channelSchema.optional()])) as Record<(typeof NOTIF_TYPES)[number], z.ZodOptional<typeof channelSchema>>).optional(),
  quietHours: quietSchema.optional(),
});

const snoozeSchema = z.object({ until: z.string().datetime() });
/** Row 75 */
const decisionSchema = z.object({ approve: z.boolean(), note: z.string().max(2000).optional() });
/** Row 74 */
const mutableEntity = z.enum(["task", "document", "project"]);
const muteSchema = z.object({ entityType: mutableEntity, entityId: z.string().uuid() });
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
    private readonly digest: DigestService,
  
    private readonly activity: ActivityService,
  ) {}

  /** Row 76: what my digest would contain right now. */
  @Get("digest/preview")
  digestPreview(@Auth() auth: AuthContext) {
    return this.digest.preview(auth.orgId, auth.userId);
  }

  /** Row 76: send my digest now, regardless of schedule. */
  @Post("digest/send")
  digestSend(@Auth() auth: AuthContext) {
    return this.digest.sendNow(auth.orgId, auth.userId);
  }

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

  /* ---- Row 77: follows ---- */

  @Get("follows")
  follows(@Auth() auth: AuthContext) {
    return this.notifications.listFollows(auth.orgId, auth.userId);
  }

  @Post("follows")
  @UsePipes(new ZodValidationPipe(muteSchema))
  follow(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof muteSchema>) {
    return this.notifications.follow(auth.orgId, auth.userId, dto.entityType, dto.entityId, "manual");
  }

  @Delete("follows/:entityType/:entityId")
  unfollow(@Auth() auth: AuthContext, @Param("entityType") entityType: string, @Param("entityId") entityId: string) {
    const parsed = mutableEntity.safeParse(entityType);
    if (!parsed.success) return { following: false };
    return this.notifications.unfollow(auth.userId, parsed.data as MutableEntity, entityId);
  }

  /* ---- Row 74: mutes ---- */

  @Get("mutes")
  mutes(@Auth() auth: AuthContext) {
    return this.notifications.listMutes(auth.orgId, auth.userId);
  }

  @Post("mutes")
  @UsePipes(new ZodValidationPipe(muteSchema))
  mute(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof muteSchema>) {
    return this.notifications.mute(auth.orgId, auth.userId, dto.entityType, dto.entityId);
  }

  @Delete("mutes/:entityType/:entityId")
  unmute(@Auth() auth: AuthContext, @Param("entityType") entityType: string, @Param("entityId") entityId: string) {
    const parsed = mutableEntity.safeParse(entityType);
    if (!parsed.success) return { muted: false };
    return this.notifications.unmute(auth.userId, parsed.data as MutableEntity, entityId);
  }

  /** Row 111: what new members start with, and the workspace quiet window. */
  @Get("workspace-defaults")
  workspaceDefaults(@Auth() auth: AuthContext) {
    return this.notifications.getWorkspaceDefaults(auth.orgId);
  }

  @Patch("workspace-defaults")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(workspaceDefaultsSchema))
  async updateWorkspaceDefaults(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof workspaceDefaultsSchema>) {
    const result = await this.notifications.updateWorkspaceDefaults(auth.orgId, dto);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "workspace", entityId: auth.orgId, action: "notification_defaults_updated", changes: [...Object.entries(dto.channels ?? {}).map(([k, v]) => ({ field: `channels.${k}`, from: null, to: v })), ...(dto.quietHours ? [{ field: "quietHours", from: null, to: dto.quietHours }] : [])] });
    return result;
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

  /** Row 75: approve / reject the request carried by this notification. */
  @Post(":id/decide")
  @UsePipes(new ZodValidationPipe(decisionSchema))
  decide(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof decisionSchema>) {
    return this.notifications.decide(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto.approve, dto.note);
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
