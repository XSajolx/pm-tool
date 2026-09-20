import { BadRequestException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { invoiceReminders, invoices, organizations } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { webBase } from "../integrations/integrations.service.js";
import { MailerService } from "../notifications/mailer.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { InvoicesService } from "./invoices.service.js";
import { backgroundJobsEnabled, registerJob } from "../../common/jobs.js";

const DAY = 86_400_000;
export const DEFAULT_REMINDER_DAYS = [3, 14, 30];

/**
 * Row 154: collections that run themselves. Every open invoice past due gets
 * a short email to the client's billing contact at each configured step
 * (3, 14, 30 days …), each step exactly once, with the client link (and Pay
 * now when Stripe is on). Paused per invoice for disputes; the log sits on
 * the invoice so everyone can see what the client was told.
 */
@Injectable()
export class DunningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DunningService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly invoices: InvoicesService,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  onModuleInit() {
    registerJob("finance.dunning", () => this.sweep());
    if (!backgroundJobsEnabled()) return; // serverless: an external scheduler calls the job instead
    this.timer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    setTimeout(() => void this.sweep(), 35_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async config(orgId: string) {
    const s = await this.invoices.settings(orgId);
    const days = (s.reminderDays ?? DEFAULT_REMINDER_DAYS).filter((d) => d > 0).sort((a, b) => a - b);
    return { enabled: s.remindersEnabled ?? true, days, note: s.reminderNote ?? "" };
  }

  /** The reminder card on an invoice: schedule, what went out, what is next. */
  async forInvoice(orgId: string, invoiceId: string) {
    const inv = await this.invoices.get(orgId, invoiceId);
    const cfg = await this.config(orgId);
    const sent = await this.db.query.invoiceReminders.findMany({ where: eq(invoiceReminders.invoiceId, invoiceId), orderBy: [desc(invoiceReminders.sentAt)] });
    const to = inv.contact?.email ?? (inv.company ? (await this.db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId), with: { company: { columns: { email: true } } } }))?.company?.email ?? null : null);
    const daysOverdue = inv.dueDate && inv.dueDate < new Date() ? Math.floor((Date.now() - inv.dueDate.getTime()) / DAY) : 0;
    const doneSteps = new Set(sent.map((r) => r.step));
    const next = inv.overdue && !inv.remindersPaused && cfg.enabled ? cfg.days.find((d) => !doneSteps.has(d)) ?? null : null;
    return {
      enabled: cfg.enabled,
      days: cfg.days,
      paused: inv.remindersPaused,
      to,
      daysOverdue,
      nextStep: next,
      nextAt: next != null && inv.dueDate ? new Date(inv.dueDate.getTime() + next * DAY).toISOString() : null,
      mailConfigured: this.mailer.configured,
      sent: sent.map((r) => ({ id: r.id, step: r.step, sentTo: r.sentTo, subject: r.subject, delivered: r.delivered, sentAt: r.sentAt.toISOString(), manual: r.step === 0 })),
    };
  }

  async setPaused(orgId: string, userId: string, invoiceId: string, paused: boolean) {
    await this.invoices.get(orgId, invoiceId);
    await this.db.update(invoices).set({ remindersPaused: paused, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: invoiceId, action: paused ? "reminders_paused" : "reminders_resumed" });
    return this.forInvoice(orgId, invoiceId);
  }

  /** Send the next due step now, or a one-off nudge (step 0) when nothing is due. */
  async sendNow(orgId: string, userId: string, invoiceId: string) {
    const card = await this.forInvoice(orgId, invoiceId);
    if (!card.to) throw new BadRequestException("The client has no email — add one to the contact or company");
    const inv = await this.invoices.get(orgId, invoiceId);
    if (!["sent", "viewed", "partially_paid"].includes(inv.status)) throw new BadRequestException("Only an open invoice can be reminded");
    await this.send(orgId, inv, card.to, card.nextStep ?? 0, card.daysOverdue, userId);
    return this.forInvoice(orgId, invoiceId);
  }

  private async send(orgId: string, inv: Awaited<ReturnType<InvoicesService["get"]>>, to: string, step: number, daysOverdue: number, byId: string | null) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true } });
    const cfg = await this.config(orgId);
    const link = `/i/${inv.token}`;
    const money = `${inv.currency} ${inv.balanceDue.toFixed(2)}`;
    const subject = daysOverdue > 0 ? `Reminder: invoice ${inv.number} is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue (${money})` : `Reminder: invoice ${inv.number} (${money})`;
    const lines = [
      `Hello${inv.contact?.name ? ` ${inv.contact.name.split(" ")[0]}` : ""},`,
      "",
      daysOverdue > 0
        ? `Invoice ${inv.number} — ${inv.title} — for ${money} was due on ${inv.dueDate!.toISOString().slice(0, 10)} and is now ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue.`
        : `A quick reminder that invoice ${inv.number} — ${inv.title} — for ${money} is outstanding.`,
      inv.amountPaid > 0 ? `${inv.currency} ${inv.amountPaid.toFixed(2)} has been received; ${money} remains.` : "",
      "",
      `You can view the invoice, download the PDF${this.invoices.payOnline(inv) ? " and pay by card" : ""} here:`,
      cfg.note ? "" : "",
      cfg.note.trim(),
      "",
      "If this has already been paid, please ignore this message or reply with the payment reference.",
      "",
      `Thank you,`,
      org?.name ?? "",
    ].filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));
    const res = await this.mailer.send({ to, subject, text: lines.join("\n"), link });
    await this.db.insert(invoiceReminders).values({ organizationId: orgId, invoiceId: inv.id, step, sentTo: to, subject, delivered: Boolean(res.sent), sentById: byId });
    await this.activity.record({ orgId, actorId: byId, entityType: "invoice", entityId: inv.id, action: "reminder_sent", changes: [{ field: "step", from: null, to: step === 0 ? "manual" : `${step} days overdue` }, { field: "to", from: null, to }, { field: "delivered", from: null, to: String(Boolean(res.sent)) }] });
    if (inv.createdBy && !byId) {
      await this.notifications.notifyDirect({ orgId, receiverId: inv.createdBy.id, entityType: "invoice", entityId: inv.id, verb: "reminder_sent", title: `${inv.number}: ${step}-day overdue reminder ${res.sent ? "emailed to" : "logged for"} ${to}`, body: res.sent ? `${money} still outstanding.` : "No mail provider is configured (RESEND_API_KEY), so nothing actually went out.", data: { invoiceId: inv.id }, category: "other" }).catch(() => undefined);
    }
    return res;
  }

  /** Hourly: every open, overdue, unpaused invoice with a client email; each step once. */
  async sweep() {
    try {
      const now = new Date();
      const rows = await this.db.query.invoices.findMany({
        where: and(isNull(invoices.archivedAt), inArray(invoices.status, ["sent", "viewed", "partially_paid"]), eq(invoices.remindersPaused, false), lt(invoices.dueDate, now)),
        columns: { id: true, organizationId: true, dueDate: true },
        orderBy: [asc(invoices.dueDate)],
      });
      let n = 0;
      const cfgs = new Map<string, Awaited<ReturnType<DunningService["config"]>>>();
      for (const r of rows) {
        const cfg = cfgs.get(r.organizationId) ?? (await this.config(r.organizationId));
        cfgs.set(r.organizationId, cfg);
        if (!cfg.enabled || !cfg.days.length) continue;
        const daysOverdue = Math.floor((now.getTime() - r.dueDate!.getTime()) / DAY);
        const done = new Set((await this.db.select({ step: invoiceReminders.step }).from(invoiceReminders).where(eq(invoiceReminders.invoiceId, r.id))).map((x) => x.step));
        // Only the highest step that is due and not yet sent — never a burst of three on a long-overdue invoice.
        const due = cfg.days.filter((d) => daysOverdue >= d && !done.has(d));
        const step = due.length ? due[due.length - 1]! : null;
        if (step == null) continue;
        const card = await this.forInvoice(r.organizationId, r.id);
        if (!card.to) continue;
        const inv = await this.invoices.get(r.organizationId, r.id);
        // Mark the skipped lower steps as done too, so they never fire later.
        for (const d of due.slice(0, -1)) await this.db.insert(invoiceReminders).values({ organizationId: r.organizationId, invoiceId: r.id, step: d, sentTo: card.to, subject: `(skipped — sent the ${step}-day reminder instead)`, delivered: false });
        await this.send(r.organizationId, inv, card.to, step, daysOverdue, null);
        n++;
      }
      if (n) this.logger.log(`dunning: ${n} reminder(s) sent`);
    } catch (err) {
      this.logger.warn(`dunning sweep failed: ${(err as Error).message}`);
    }
  }
}
