import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, contacts, invoiceSchedules, invoices, memberships, projects, reminders, type ScheduleItem } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService, pendingApproval } from "../notifications/notifications.service.js";
import { InvoicesService, computeTotals } from "./invoices.service.js";
import { backgroundJobsEnabled, registerJob } from "../../common/jobs.js";

export type ScheduleKind = "recurring" | "subscription";
export type ScheduleUnit = "week" | "month" | "year";
export type ScheduleStatus = "active" | "paused" | "ended";
/** UI-level presets; custom = any every×unit. */
export type Frequency = "weekly" | "monthly" | "quarterly" | "yearly" | "custom";

export interface ScheduleDto {
  name?: string;
  kind?: ScheduleKind;
  title?: string;
  companyId?: string | null;
  contactId?: string | null;
  projectId?: string | null;
  currency?: string;
  items?: ScheduleItem[];
  taxRate?: number;
  discountPercent?: number;
  notes?: string | null;
  dueDays?: number;
  autoSend?: boolean;
  /** Row 138 */
  reviewerId?: string | null;
  reviewNudgeDays?: number;
  every?: number;
  unit?: ScheduleUnit;
  startsAt?: string;
  endsAt?: string | null;
  maxOccurrences?: number | null;
}

export const PRESETS: Record<Exclude<Frequency, "custom">, { every: number; unit: ScheduleUnit }> = {
  weekly: { every: 1, unit: "week" },
  monthly: { every: 1, unit: "month" },
  quarterly: { every: 3, unit: "month" },
  yearly: { every: 1, unit: "year" },
};

/** Add the cadence to a date. Month/year steps keep the anchor day and clamp to the month's length. */
export function advance(from: Date, every: number, unit: ScheduleUnit, anchorDay?: number | null): Date {
  const d = new Date(from.getTime());
  if (unit === "week") {
    d.setUTCDate(d.getUTCDate() + 7 * every);
    return d;
  }
  const months = unit === "year" ? 12 * every : every;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const daysInMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay ?? d.getUTCDate(), daysInMonth));
  return target;
}

@Injectable()
export class SchedulesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulesService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly invoices: InvoicesService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    registerJob("finance.schedules", () => this.sweep());
    if (!backgroundJobsEnabled()) return; // serverless: an external scheduler calls the job instead
    this.timer = setInterval(() => void this.sweep(), 5 * 60 * 1000);
    setTimeout(() => void this.sweep(), 8000);
    // Row 138: the reviewer's inbox card — Approve = send it, Reject = leave the draft with a note.
    this.notifications.registerApproval("invoice_review", (d) => this.review(d.orgId, { userId: d.userId, role: d.role }, d.entityId, d.approve, d.note));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------------- read ---------------- */

  async list(orgId: string, opts: { companyId?: string; status?: string } = {}) {
    const rows = await this.db.query.invoiceSchedules.findMany({
      where: and(
        eq(invoiceSchedules.organizationId, orgId),
        isNull(invoiceSchedules.archivedAt),
        ...(opts.companyId ? [eq(invoiceSchedules.companyId, opts.companyId)] : []),
        ...(opts.status && opts.status !== "all" ? [eq(invoiceSchedules.status, opts.status as ScheduleStatus)] : []),
      ),
      with: { company: { columns: { id: true, name: true } }, contact: { columns: { id: true, firstName: true, lastName: true } }, project: { columns: { id: true, name: true } }, reviewer: { columns: { id: true, name: true } } },
      orderBy: [asc(invoiceSchedules.status), asc(invoiceSchedules.nextRunAt), desc(invoiceSchedules.createdAt)],
    });
    return rows.map((r) => shape(r));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.invoiceSchedules.findFirst({
      where: and(eq(invoiceSchedules.id, id), eq(invoiceSchedules.organizationId, orgId)),
      with: {
        reviewer: { columns: { id: true, name: true } },
        company: { columns: { id: true, name: true } },
        contact: { columns: { id: true, firstName: true, lastName: true } },
        project: { columns: { id: true, name: true } },
        createdBy: { columns: { id: true, name: true } },
      },
    });
    if (!row) throw new NotFoundException("Schedule not found");
    const generated = await this.invoices.list(orgId, { scheduleId: id });
    return { ...shape(row), createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null, invoices: generated };
  }

  /* ---------------- write ---------------- */

  /** From scratch, or copy an existing invoice's lines and client (`fromInvoiceId`) — "make this recurring". */
  async create(orgId: string, userId: string, dto: ScheduleDto & { fromInvoiceId?: string | null }) {
    let seed: Partial<ScheduleDto> = {};
    if (dto.fromInvoiceId) {
      const inv = await this.invoices.get(orgId, dto.fromInvoiceId);
      seed = {
        title: inv.title,
        companyId: inv.company?.id ?? null,
        contactId: inv.contact?.id ?? null,
        projectId: inv.project?.id ?? null,
        currency: inv.currency,
        items: inv.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })),
        taxRate: inv.taxRate,
        discountPercent: inv.discountPercent,
        notes: inv.notes,
        dueDays: inv.dueDate ? Math.max(0, Math.round((inv.dueDate.getTime() - inv.issueDate.getTime()) / 86_400_000)) : 14,
      };
    }
    const merged = { ...seed, ...stripUndefined(dto) };
    await this.assertLinks(orgId, merged);
    const title = (merged.title?.trim() || "Invoice").slice(0, 255);
    const name = (merged.name?.trim() || title).slice(0, 255);
    const every = Math.max(1, Math.round(merged.every ?? 1));
    const unit = merged.unit ?? "month";
    const startsAt = merged.startsAt ? new Date(merged.startsAt) : new Date();
    if (Number.isNaN(startsAt.getTime())) throw new BadRequestException("Invalid start date");
    const endsAt = merged.endsAt ? new Date(merged.endsAt) : null;
    if (endsAt && endsAt < startsAt) throw new BadRequestException("End date is before the start date");
    const [row] = await this.db
      .insert(invoiceSchedules)
      .values({
        organizationId: orgId,
        createdById: userId,
        name,
        kind: merged.kind ?? "recurring",
        title,
        companyId: merged.companyId ?? null,
        contactId: merged.contactId ?? null,
        projectId: merged.projectId ?? null,
        currency: (merged.currency ?? "USD").toUpperCase(),
        items: cleanItems(merged.items ?? []),
        taxRate: merged.taxRate ?? 0,
        discountPercent: merged.discountPercent ?? 0,
        notes: merged.notes ?? null,
        dueDays: Math.max(0, Math.round(merged.dueDays ?? 14)),
        autoSend: Boolean(merged.autoSend),
        reviewerId: merged.reviewerId ?? null,
        reviewNudgeDays: merged.reviewNudgeDays ?? 2,
        every,
        unit,
        anchorDay: unit === "week" ? null : startsAt.getUTCDate(),
        startsAt,
        nextRunAt: startsAt,
        endsAt,
        maxOccurrences: merged.maxOccurrences ?? null,
      })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: row!.id, action: "schedule_created", changes: [{ field: "name", from: null, to: name }] });
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: ScheduleDto) {
    const before = await this.get(orgId, id);
    await this.assertLinks(orgId, dto);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim() || before.name;
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.title !== undefined) patch.title = dto.title.trim() || before.title;
    for (const k of ["companyId", "contactId", "projectId", "notes"] as const) if (dto[k] !== undefined) patch[k] = dto[k];
    if (dto.currency !== undefined) patch.currency = dto.currency.toUpperCase();
    if (dto.items !== undefined) patch.items = cleanItems(dto.items);
    if (dto.taxRate !== undefined) patch.taxRate = dto.taxRate;
    if (dto.discountPercent !== undefined) patch.discountPercent = dto.discountPercent;
    if (dto.dueDays !== undefined) patch.dueDays = Math.max(0, Math.round(dto.dueDays));
    if (dto.autoSend !== undefined) patch.autoSend = dto.autoSend;
    if (dto.reviewerId !== undefined) patch.reviewerId = dto.reviewerId;
    if (dto.reviewNudgeDays !== undefined) patch.reviewNudgeDays = Math.max(0, Math.min(30, Math.round(dto.reviewNudgeDays)));
    if (dto.every !== undefined) patch.every = Math.max(1, Math.round(dto.every));
    if (dto.unit !== undefined) patch.unit = dto.unit;
    if (dto.maxOccurrences !== undefined) patch.maxOccurrences = dto.maxOccurrences;
    if (dto.endsAt !== undefined) patch.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (dto.startsAt !== undefined) {
      const s = new Date(dto.startsAt);
      if (Number.isNaN(s.getTime())) throw new BadRequestException("Invalid start date");
      patch.startsAt = s;
      // Moving the start moves the next run too, unless invoices were already generated (then the next run stands).
      if (before.occurrences === 0) patch.nextRunAt = s;
      patch.anchorDay = (dto.unit ?? before.unit) === "week" ? null : s.getUTCDate();
    } else if (dto.unit !== undefined && dto.unit !== before.unit) {
      patch.anchorDay = dto.unit === "week" ? null : (before.nextRunAt ?? before.startsAt).getUTCDate();
    }
    // Limits and status stay consistent: tightening a limit below what has already run ends the
    // schedule; relaxing the limit on an ended one brings it back to life.
    if (dto.endsAt !== undefined || dto.maxOccurrences !== undefined) {
      const endsAt = dto.endsAt !== undefined ? (patch.endsAt as Date | null) : before.endsAt;
      const max = dto.maxOccurrences !== undefined ? dto.maxOccurrences : before.maxOccurrences;
      const next = (patch.nextRunAt as Date | undefined) ?? before.nextRunAt ?? new Date();
      const reached = (max != null && before.occurrences >= max) || (endsAt != null && endsAt < next);
      if (reached && before.status !== "ended") {
        patch.status = "ended";
        patch.endedAt = new Date();
        patch.nextRunAt = null;
      } else if (!reached && before.status === "ended") {
        patch.status = "active";
        patch.endedAt = null;
        let n = before.nextRunAt ?? before.startsAt;
        while (n < new Date()) n = advance(n, before.every, before.unit, before.anchorDay);
        patch.nextRunAt = n;
      }
    }
    await this.db.update(invoiceSchedules).set(patch).where(eq(invoiceSchedules.id, id));
    void userId;
    return this.get(orgId, id);
  }

  async pause(orgId: string, userId: string, id: string) {
    const s = await this.get(orgId, id);
    if (s.status !== "active") throw new BadRequestException(`Cannot pause a schedule that is ${s.status}`);
    await this.db.update(invoiceSchedules).set({ status: "paused", pausedAt: new Date(), updatedAt: new Date() }).where(eq(invoiceSchedules.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "schedule_paused" });
    return this.get(orgId, id);
  }

  /** Resuming never back-fills missed runs: the next run is the first cadence date from now. */
  async resume(orgId: string, userId: string, id: string) {
    const s = await this.get(orgId, id);
    if (s.status !== "paused") throw new BadRequestException(`Cannot resume a schedule that is ${s.status}`);
    const now = new Date();
    let next = s.nextRunAt ?? s.startsAt;
    while (next < now) next = advance(next, s.every, s.unit, s.anchorDay);
    await this.db.update(invoiceSchedules).set({ status: "active", pausedAt: null, nextRunAt: next, updatedAt: now }).where(eq(invoiceSchedules.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "schedule_resumed" });
    return this.get(orgId, id);
  }

  async end(orgId: string, userId: string, id: string) {
    const s = await this.get(orgId, id);
    if (s.status === "ended") return s;
    await this.db.update(invoiceSchedules).set({ status: "ended", endedAt: new Date(), nextRunAt: null, updatedAt: new Date() }).where(eq(invoiceSchedules.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "schedule_ended" });
    return this.get(orgId, id);
  }

  async archive(orgId: string, userId: string, id: string) {
    await this.get(orgId, id);
    await this.db.update(invoiceSchedules).set({ archivedAt: new Date(), status: "ended", nextRunAt: null }).where(eq(invoiceSchedules.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "schedule_archived" });
    return { id, archived: true };
  }

  /** "Run now": generate the next invoice immediately; the cadence continues from the scheduled date. */
  async runNow(orgId: string, userId: string, id: string) {
    const s = await this.db.query.invoiceSchedules.findFirst({ where: and(eq(invoiceSchedules.id, id), eq(invoiceSchedules.organizationId, orgId)) });
    if (!s) throw new NotFoundException("Schedule not found");
    if (s.status === "ended") throw new BadRequestException("This schedule has ended");
    await this.generate(s, userId, true);
    return this.get(orgId, id);
  }

  /* ---------------- the sweep ---------------- */

  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.db.query.invoiceSchedules.findMany({
        where: and(eq(invoiceSchedules.status, "active"), isNull(invoiceSchedules.archivedAt), lte(invoiceSchedules.nextRunAt, new Date())),
        orderBy: asc(invoiceSchedules.nextRunAt),
        limit: 100,
      });
      let n = 0;
      for (const s of due) {
        try {
          if (await this.generate(s, s.createdById, false)) n++;
        } catch (err) {
          const message = (err as Error).message.slice(0, 500);
          this.logger.warn(`schedule ${s.id} failed: ${message}`);
          // Don't retry every 5 minutes forever: push the run out a day and record why.
          await this.db.update(invoiceSchedules).set({ lastError: message, nextRunAt: new Date(Date.now() + 86_400_000), updatedAt: new Date() }).where(eq(invoiceSchedules.id, s.id));
          if (s.createdById) {
            await this.notifications.notifyDirect({ orgId: s.organizationId, receiverId: s.createdById, entityType: "invoice_schedule", entityId: s.id, verb: "schedule_failed", title: `Recurring invoice "${s.name}" could not be generated`, body: message, data: { scheduleId: s.id } });
          }
        }
      }
      if (n) this.logger.log(`generated ${n} scheduled invoice(s)`);
      // Row 138: drafts nobody sent get one nudge each.
      await this.nudgeUnsent().catch((err) => this.logger.warn(`nudge failed: ${(err as Error).message}`));
    } catch (err) {
      this.logger.warn(`schedule sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One occurrence: create the invoice (and send it if the schedule says so),
   * then move `next_run_at` forward from the SCHEDULED date so the cadence
   * never drifts, and end the schedule when its limit is reached.
   */
  private async generate(s: typeof invoiceSchedules.$inferSelect, actorId: string | null, manual: boolean) {
    // Belt and braces: a schedule whose limit is already reached ends instead of producing one more.
    if (!manual && ((s.maxOccurrences && s.occurrences >= s.maxOccurrences) || (s.endsAt && (s.nextRunAt ?? s.startsAt) > s.endsAt))) {
      await this.db.update(invoiceSchedules).set({ status: "ended", endedAt: new Date(), nextRunAt: null, updatedAt: new Date() }).where(eq(invoiceSchedules.id, s.id));
      return null;
    }
    const runAt = s.nextRunAt ?? s.startsAt;
    const issueDate = manual ? new Date() : runAt;
    const inv = await this.invoices.create(s.organizationId, actorId ?? s.createdById ?? "", {
      title: s.title,
      companyId: s.companyId,
      contactId: s.contactId,
      projectId: s.projectId,
      currency: s.currency,
      items: s.items,
      taxRate: s.taxRate,
      discountPercent: s.discountPercent,
      notes: s.notes,
      issueDate: issueDate.toISOString(),
      dueDate: new Date(issueDate.getTime() + s.dueDays * 86_400_000).toISOString(),
      scheduleId: s.id,
    });
    let sent = false;
    if (s.autoSend && inv.items.length && inv.total > 0) {
      await this.invoices.send(s.organizationId, actorId ?? s.createdById ?? "", inv.id, { system: true });
      sent = true;
    }

    const occurrences = s.occurrences + 1;
    // Manual runs don't consume the scheduled slot; scheduled runs advance past now.
    let next: Date | null = manual ? runAt : advance(runAt, s.every, s.unit, s.anchorDay);
    if (!manual) while (next && next <= new Date()) next = advance(next, s.every, s.unit, s.anchorDay);
    let status: ScheduleStatus = s.status;
    if ((s.maxOccurrences && occurrences >= s.maxOccurrences) || (s.endsAt && next && next > s.endsAt)) {
      status = "ended";
      next = null;
    }
    await this.db
      .update(invoiceSchedules)
      .set({ occurrences, lastRunAt: new Date(), lastInvoiceId: inv.id, lastError: null, nextRunAt: next, status, endedAt: status === "ended" ? new Date() : null, updatedAt: new Date() })
      .where(eq(invoiceSchedules.id, s.id));

    // Row 138: a draft goes to the named reviewer as an approval card (Approve = send). Auto-sent ones just inform.
    const reviewer = s.reviewerId ?? s.createdById;
    if (reviewer) {
      await this.notifications.notifyDirect({
        orgId: s.organizationId,
        receiverId: reviewer,
        entityType: "invoice",
        entityId: inv.id,
        verb: sent ? "invoice_auto_sent" : "invoice_review",
        title: sent ? `${inv.number} was sent to ${inv.company?.name ?? inv.contact?.name ?? "the client"} (${s.name})` : `Review & send ${inv.number} — ${s.name} (${inv.currency} ${inv.total.toFixed(2)})`,
        body: sent ? "Sent automatically by the billing schedule — the client link is live." : `Generated as a draft for ${inv.company?.name ?? inv.contact?.name ?? "the client"}. Approve to send it, or open it to adjust the lines first.`,
        data: sent ? { invoiceId: inv.id, scheduleId: s.id } : { invoiceId: inv.id, scheduleId: s.id, approval: pendingApproval("invoice_review") },
        category: sent ? "other" : "primary",
      });
    }
    return inv;
  }

  /* ---------------- row 138: review & nudge ---------------- */

  /** Approve from the inbox = send the draft; reject = keep it as a draft and note why. */
  async review(orgId: string, actor: { userId: string; role: string }, invoiceId: string, approve: boolean, note?: string | null) {
    const inv = await this.invoices.get(orgId, invoiceId);
    const admin = actor.role === "owner" || actor.role === "admin";
    const sched = inv.schedule ? await this.db.query.invoiceSchedules.findFirst({ where: eq(invoiceSchedules.id, inv.schedule.id), columns: { reviewerId: true, createdById: true } }) : null;
    const named = sched?.reviewerId ?? sched?.createdById;
    if (!admin && named !== actor.userId) throw new ForbiddenException("Only the named reviewer or an admin can issue this invoice");
    if (approve) {
      if (inv.status !== "draft") return inv; // already dealt with
      const sent = await this.invoices.send(orgId, actor.userId, invoiceId);
      await this.notifications.resolveApproval("invoice", invoiceId, "approved", note, actor.userId);
      return sent;
    }
    await this.notifications.resolveApproval("invoice", invoiceId, "rejected", note, actor.userId);
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "invoice", entityId: invoiceId, action: "review_held", changes: note?.trim() ? [{ field: "note", from: null, to: note.trim() }] : [] });
    return inv;
  }

  /** Drafts a schedule generated that are still unsent after the nudge window: one reminder each, to the reviewer. */
  async nudgeUnsent() {
    const rows = await this.db
      .select({ invId: invoices.id, number: invoices.number, orgId: invoices.organizationId, createdAt: invoices.createdAt, total: invoices.total, currency: invoices.currency, schedId: invoiceSchedules.id, name: invoiceSchedules.name, reviewerId: invoiceSchedules.reviewerId, createdById: invoiceSchedules.createdById, days: invoiceSchedules.reviewNudgeDays })
      .from(invoices)
      .innerJoin(invoiceSchedules, eq(invoiceSchedules.id, invoices.scheduleId))
      .where(and(eq(invoices.status, "draft"), isNull(invoices.archivedAt), sql`${invoiceSchedules.reviewNudgeDays} > 0`, sql`${invoices.createdAt} < now() - (${invoiceSchedules.reviewNudgeDays} || ' days')::interval`));
    let n = 0;
    for (const r of rows) {
      const receiver = r.reviewerId ?? r.createdById;
      if (!receiver) continue;
      const claimed = await this.db.insert(reminders).values({ organizationId: r.orgId, receiverId: receiver, entityType: "invoice", entityId: r.invId, kind: "unsent_draft", dueAt: r.createdAt }).onConflictDoNothing().returning({ id: reminders.id });
      if (!claimed.length) continue;
      const age = Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000);
      await this.notifications.notifyDirect({ orgId: r.orgId, receiverId: receiver, entityType: "invoice", entityId: r.invId, verb: "invoice_unsent", title: `${r.number} (${r.name}) is still a draft after ${age} day${age === 1 ? "" : "s"}`, body: `${r.currency} ${r.total.toFixed(2)} has not gone out. Open it and send, or it stays unbilled.`, data: { invoiceId: r.invId, scheduleId: r.schedId }, category: "primary" });
      n++;
    }
    return n;
  }

  /** Row 138: drafts generated by schedules that nobody has sent yet. */
  async awaitingReview(orgId: string) {
    const rows = await this.db
      .select({ id: invoices.id, number: invoices.number, title: invoices.title, total: invoices.total, currency: invoices.currency, createdAt: invoices.createdAt, scheduleId: invoiceSchedules.id, scheduleName: invoiceSchedules.name, reviewerId: invoiceSchedules.reviewerId })
      .from(invoices)
      .innerJoin(invoiceSchedules, eq(invoiceSchedules.id, invoices.scheduleId))
      .where(and(eq(invoices.organizationId, orgId), eq(invoices.status, "draft"), isNull(invoices.archivedAt)))
      .orderBy(asc(invoices.createdAt));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), ageDays: Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000) }));
  }

  /** Members who can be named as reviewer (owners/admins — they are the ones allowed to send). */
  async reviewers(orgId: string) {
    const rows = await this.db.query.memberships.findMany({ where: and(eq(memberships.organizationId, orgId), sql`${memberships.role} in ('owner','admin')`), with: { user: { columns: { id: true, name: true, email: true } } } });
    return rows.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
  }

  /* ---------------- helpers ---------------- */

  private async assertLinks(orgId: string, dto: Partial<ScheduleDto>) {
    const checks: [string | null | undefined, () => Promise<unknown>, string][] = [
      [dto.companyId, () => this.db.query.companies.findFirst({ where: and(eq(companies.id, dto.companyId!), eq(companies.organizationId, orgId)) }), "Company"],
      [dto.contactId, () => this.db.query.contacts.findFirst({ where: and(eq(contacts.id, dto.contactId!), eq(contacts.organizationId, orgId)) }), "Contact"],
      [dto.projectId, () => this.db.query.projects.findFirst({ where: and(eq(projects.id, dto.projectId!), eq(projects.organizationId, orgId)) }), "Project"],
    ];
    for (const [id, find, label] of checks) if (id && !(await find())) throw new BadRequestException(`${label} not found in this organization`);
  }

  /** Header number for the list page: how many are live and when the next one fires. */
  async summary(orgId: string) {
    const [row] = await this.db
      .select({ active: sql<number>`count(*) filter (where ${invoiceSchedules.status} = 'active')::int`, next: sql<Date | null>`min(${invoiceSchedules.nextRunAt}) filter (where ${invoiceSchedules.status} = 'active')` })
      .from(invoiceSchedules)
      .where(and(eq(invoiceSchedules.organizationId, orgId), isNull(invoiceSchedules.archivedAt)));
    const [gen] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), sql`${invoices.scheduleId} is not null`));
    return { active: row?.active ?? 0, nextRunAt: row?.next ?? null, generated: gen?.n ?? 0 };
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function cleanItems(items: ScheduleItem[]): ScheduleItem[] {
  return items
    .filter((i) => i && typeof i.description === "string" && i.description.trim())
    .map((i) => ({ description: i.description.trim().slice(0, 2000), quantity: Number(i.quantity) || 0, unitPrice: Number(i.unitPrice) || 0 }))
    .slice(0, 200);
}

function shape(
  r: typeof invoiceSchedules.$inferSelect & {
    company: { id: string; name: string } | null;
    contact: { id: string; firstName: string | null; lastName: string | null } | null;
    project: { id: string; name: string } | null;
    reviewer?: { id: string; name: string } | null;
  },
) {
  const totals = computeTotals(r.items, r.discountPercent, r.taxRate);
  const frequency: Frequency =
    r.unit === "week" && r.every === 1 ? "weekly" : r.unit === "month" && r.every === 1 ? "monthly" : r.unit === "month" && r.every === 3 ? "quarterly" : r.unit === "year" && r.every === 1 ? "yearly" : "custom";
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    title: r.title,
    currency: r.currency,
    items: r.items,
    taxRate: r.taxRate,
    discountPercent: r.discountPercent,
    notes: r.notes,
    dueDays: r.dueDays,
    autoSend: r.autoSend,
    reviewerId: r.reviewerId,
    reviewer: r.reviewer ? { id: r.reviewer.id, name: r.reviewer.name } : null,
    reviewNudgeDays: r.reviewNudgeDays,
    every: r.every,
    unit: r.unit,
    frequency,
    anchorDay: r.anchorDay,
    startsAt: r.startsAt,
    nextRunAt: r.nextRunAt,
    endsAt: r.endsAt,
    maxOccurrences: r.maxOccurrences,
    occurrences: r.occurrences,
    lastRunAt: r.lastRunAt,
    lastInvoiceId: r.lastInvoiceId,
    lastError: r.lastError,
    pausedAt: r.pausedAt,
    endedAt: r.endedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    amount: totals.total,
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    contact: r.contact ? { id: r.contact.id, name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(" ") } : null,
    project: r.project ? { id: r.project.id, name: r.project.name } : null,
  };
}
