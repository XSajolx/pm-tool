import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { notificationPreferences, notifications, taskAssignees, tasks, users } from "../../db/schema.js";
import { MailerService } from "./mailer.service.js";
import { NotificationsService } from "./notifications.service.js";

import { DEFAULT_DIGEST, resolveDigest, type DigestPrefs } from "./digest.prefs.js";
export { DEFAULT_DIGEST, resolveDigest, type DigestPrefs };

export interface DigestItem {
  id: string;
  title: string;
  /** ISO date for tasks; free text otherwise. */
  meta?: string | null;
  link?: string;
}
export interface DigestSections {
  period: "daily" | "weekly";
  since: string;
  dueToday: DigestItem[];
  overdue: DigestItem[];
  assignments: DigestItem[];
  mentions: DigestItem[];
}

/**
 * Composes and delivers the daily / weekly digest: tasks due today, overdue
 * items, new assignments since the last digest and unread mentions. A sweep
 * runs every ten minutes and sends to whoever is due; "send now" and
 * "preview" exist for the settings popover.
 */
@Injectable()
export class DigestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DigestService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly notifications: NotificationsService,
    private readonly mailer: MailerService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), 10 * 60 * 1000);
    setTimeout(() => void this.sweep(), 12_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Everyone whose digest is on and due right now gets one. */
  async sweep() {
    try {
      const rows = await this.db.select().from(notificationPreferences).where(isNotNull(notificationPreferences.digest));
      const now = new Date();
      let sent = 0;
      for (const row of rows) {
        const prefs = resolveDigest(row.digest);
        if (!this.isDue(prefs, row.digestLastSentAt, now)) continue;
        await this.send(row.organizationId, row.userId, prefs, row.digestLastSentAt);
        sent++;
      }
      if (sent) this.logger.log(`sent ${sent} digest(s)`);
    } catch (err) {
      this.logger.warn(`digest sweep failed: ${(err as Error).message}`);
    }
  }

  private isDue(prefs: DigestPrefs, last: Date | null, now: Date) {
    if (prefs.frequency === "off") return false;
    if (now.getHours() < prefs.hour) return false;
    const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (prefs.frequency === "daily") return !last || !sameDay(last, now);
    if (now.getDay() !== prefs.weekday) return false;
    return !last || now.getTime() - last.getTime() > 6 * 24 * 3600 * 1000;
  }

  /** What the digest would say right now (settings popover preview). */
  async preview(orgId: string, userId: string) {
    const row = await this.db.query.notificationPreferences.findFirst({
      where: and(eq(notificationPreferences.organizationId, orgId), eq(notificationPreferences.userId, userId)),
    });
    const prefs = resolveDigest(row?.digest);
    return this.compose(orgId, userId, prefs.frequency === "weekly" ? "weekly" : "daily", row?.digestLastSentAt ?? null);
  }

  /** "Send me one now" - ignores the schedule, respects the channel switches. */
  async sendNow(orgId: string, userId: string) {
    const row = await this.db.query.notificationPreferences.findFirst({
      where: and(eq(notificationPreferences.organizationId, orgId), eq(notificationPreferences.userId, userId)),
    });
    const prefs = resolveDigest(row?.digest);
    return this.send(orgId, userId, { ...prefs, inApp: prefs.inApp || !prefs.email }, row?.digestLastSentAt ?? null, true);
  }

  private async send(orgId: string, userId: string, prefs: DigestPrefs, last: Date | null, force = false) {
    const period = prefs.frequency === "weekly" ? "weekly" : "daily";
    const sections = await this.compose(orgId, userId, period, last);
    const counts = summarise(sections);
    const empty = !sections.dueToday.length && !sections.overdue.length && !sections.assignments.length && !sections.mentions.length;
    const now = new Date();
    await this.db
      .insert(notificationPreferences)
      .values({ organizationId: orgId, userId, digest: prefs, digestLastSentAt: now })
      .onConflictDoUpdate({ target: [notificationPreferences.organizationId, notificationPreferences.userId], set: { digestLastSentAt: now } });
    if (empty && !force) return { sent: false, sections };

    const title = `Your ${period} digest - ${counts}`;
    const text = renderText(sections);
    if (prefs.inApp) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId: userId,
        entityType: "digest",
        entityId: userId,
        verb: "digest",
        title,
        body: empty ? "Nothing due, nothing overdue, no new assignments or mentions." : counts,
        data: { sections },
        category: "other",
      });
    }
    if (prefs.email) {
      const [u] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (u) void this.mailer.send({ to: u.email, subject: title, text, link: "/inbox" });
    }
    return { sent: true, sections };
  }

  async compose(orgId: string, userId: string, period: "daily" | "weekly", last: Date | null): Promise<DigestSections> {
    const now = new Date();
    const since = last ?? new Date(now.getTime() - (period === "weekly" ? 7 : 1) * 24 * 3600 * 1000);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

    const mine = this.db
      .select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate })
      .from(tasks)
      .innerJoin(taskAssignees, eq(taskAssignees.taskId, tasks.id))
      .where(and(eq(tasks.organizationId, orgId), eq(taskAssignees.userId, userId), isNull(tasks.completedAt), isNull(tasks.archivedAt)))
      .as("mine");
    const open = await this.db.select().from(mine).where(and(gte(mine.dueDate, new Date(0)), lt(mine.dueDate, dayEnd))).limit(200);
    const dueToday = open.filter((t) => t.dueDate! >= dayStart);
    const overdue = open.filter((t) => t.dueDate! < dayStart);

    const recent = await this.db
      .select({ id: notifications.id, entityType: notifications.entityType, entityId: notifications.entityId, verb: notifications.verb, title: notifications.title, body: notifications.body, readAt: notifications.readAt, createdAt: notifications.createdAt, data: notifications.data })
      .from(notifications)
      .where(and(eq(notifications.organizationId, orgId), eq(notifications.receiverId, userId), isNull(notifications.archivedAt), inArray(notifications.verb, ["assigned", "mentioned", "comment_assigned"]), gt(notifications.createdAt, new Date(since.getTime() - 7 * 24 * 3600 * 1000))))
      .orderBy(desc(notifications.createdAt))
      .limit(200);
    const assignments = recent.filter((n) => n.verb === "assigned" && n.createdAt > since);
    const mentions = recent.filter((n) => n.verb !== "assigned" && !n.readAt);

    const taskItem = (t: { id: string; title: string; dueDate: Date | null }): DigestItem => ({ id: t.id, title: t.title, meta: t.dueDate?.toISOString() ?? null, link: `/t/${t.id}` });
    const noteItem = (n: (typeof recent)[number]): DigestItem => ({
      id: n.id,
      title: n.title,
      meta: n.body,
      link: n.entityType === "task" ? `/t/${n.entityId}` : n.entityType === "message" && typeof n.data?.channelId === "string" ? `/chat/${n.data.channelId}` : "/inbox",
    });
    return {
      period,
      since: since.toISOString(),
      dueToday: dueToday.map(taskItem),
      overdue: overdue.map(taskItem),
      assignments: assignments.map(noteItem),
      mentions: mentions.map(noteItem),
    };
  }
}

function summarise(s: DigestSections) {
  const bit = (n: number, word: string) => `${n} ${word}`;
  return [bit(s.dueToday.length, "due today"), bit(s.overdue.length, "overdue"), bit(s.assignments.length, "new"), bit(s.mentions.length, s.mentions.length === 1 ? "unread mention" : "unread mentions")].join(" · ");
}

function renderText(s: DigestSections) {
  const block = (label: string, items: DigestItem[]) => (items.length ? [`${label} (${items.length})`, ...items.map((i) => `  - ${i.title}${i.meta ? ` (${i.meta.length > 60 ? i.meta.slice(0, 57) + "..." : i.meta})` : ""}`), ""] : []);
  const lines = [...block("Due today", s.dueToday), ...block("Overdue", s.overdue), ...block("New assignments", s.assignments), ...block("Unread mentions", s.mentions)];
  return lines.length ? lines.join("\n") : "Nothing due, nothing overdue, no new assignments or mentions.";
}
