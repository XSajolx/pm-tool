import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, contacts, deals, estimateItems, estimates, expenses, invoiceItems, invoicePayments, invoices, memberships, organizations, projects, proposals, timeEntries, type InvoicingSettings } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService, pendingApproval } from "../notifications/notifications.service.js";
import { renderInvoicePdf } from "./invoice-pdf.js";
import { ProfitFirstService } from "./profit-first.service.js";
import { stripeConfigured } from "./stripe.config.js";

export type InvoiceStatus = "draft" | "review" | "sent" | "viewed" | "partially_paid" | "paid" | "void" | "superseded";

export const DEFAULT_INVOICING: InvoicingSettings = { prefix: "INV-", padding: 4, nextNumber: null, defaultDueDays: 14, defaultTaxRate: 0, defaultCurrency: "USD", defaultNotes: "", requireReview: false };
export type PaymentMethod = "bank_transfer" | "card" | "cash" | "cheque" | "other";

export interface InvoiceItemDto {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Row 137 */
  stageId?: string | null;
  billedPct?: number | null;
}

export interface InvoiceDto {
  title?: string;
  companyId?: string | null;
  contactId?: string | null;
  projectId?: string | null;
  dealId?: string | null;
  currency?: string;
  issueDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  taxRate?: number;
  discountPercent?: number;
  items?: InvoiceItemDto[];
}

export interface CreateInvoiceDto extends InvoiceDto {
  /** Internal: set by the schedule sweep (row 157). Never accepted from the API. */
  scheduleId?: string | null;
  /** Copy the lines of an estimate (any status) — the usual "accepted quote → invoice" path. */
  fromEstimateId?: string | null;
  /** One line for the proposal total. */
  fromProposalId?: string | null;
}

export interface PaymentDto {
  amount: number;
  method?: PaymentMethod;
  paidAt?: string | null;
  reference?: string | null;
  note?: string | null;
  /** Row 129: set by the Stripe settle path only. */
  provider?: "stripe" | null;
  providerRef?: string | null;
}

/** Statuses that still expect money. */
const OPEN: InvoiceStatus[] = ["sent", "viewed", "partially_paid"];
const EPS = 0.005;

@Injectable()
export class InvoicesService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly profitFirst: ProfitFirstService,
  ) {}

  /** Row 139: the review card in an admin's inbox — Approve issues the invoice, Reject returns it to draft. */
  onModuleInit() {
    this.notifications.registerApproval("invoice_issue", (d) => (d.approve ? this.send(d.orgId, d.userId, d.entityId).then(() => undefined) : this.returnToDraft(d.orgId, d.userId, d.entityId, d.note).then(() => undefined)));
  }

  /* ---------------- row 139: settings ---------------- */

  async settings(orgId: string): Promise<InvoicingSettings> {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { invoicing: true } });
    return { ...DEFAULT_INVOICING, ...(org?.invoicing ?? {}) };
  }

  async updateSettings(orgId: string, userId: string, patch: Partial<InvoicingSettings>) {
    const before = await this.settings(orgId);
    const next: InvoicingSettings = {
      ...before,
      ...patch,
      prefix: (patch.prefix ?? before.prefix).trim().slice(0, 12),
      padding: Math.min(8, Math.max(1, Math.round(patch.padding ?? before.padding))),
      defaultCurrency: (patch.defaultCurrency ?? before.defaultCurrency).toUpperCase().slice(0, 3),
    };
    if (next.nextNumber != null) {
      const used = await this.highestNumber(orgId, next.prefix);
      if (next.nextNumber <= used) throw new BadRequestException(`${next.prefix}${String(used).padStart(next.padding, "0")} is already used — the next number must be at least ${used + 1}`);
    }
    await this.db.update(organizations).set({ invoicing: next, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "invoicing_settings_updated", changes: (Object.keys(patch) as (keyof InvoicingSettings)[]).filter((k) => before[k] !== next[k]).map((k) => ({ field: k, from: String(before[k] ?? ""), to: String(next[k] ?? "") })) });
    return next;
  }

  /** Highest numeric suffix used with this prefix (revisions share their original's number). */
  private async highestNumber(orgId: string, prefix: string) {
    const rows = await this.db.select({ number: invoices.number }).from(invoices).where(and(eq(invoices.organizationId, orgId), sql`${invoices.number} like ${prefix + "%"}`));
    let max = 0;
    for (const r of rows) {
      const n = Number(r.number.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return max;
  }

  /* ---------------- row 139: review & issue ---------------- */

  /** A member (or anyone) hands a draft to the admins; they get an inbox card with Approve = issue. */
  async submitForReview(orgId: string, userId: string, id: string) {
    const inv = await this.get(orgId, id);
    if (inv.status !== "draft") throw new BadRequestException("Only a draft can be submitted for review");
    if (!inv.items.length || inv.total <= 0) throw new BadRequestException("Add lines with a total before submitting");
    const now = new Date();
    await this.db.update(invoices).set({ status: "review", submittedForReviewAt: now, submittedById: userId, updatedAt: now }).where(eq(invoices.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "submitted_for_review", changes: [{ field: "status", from: "draft", to: "review" }] });
    const admins = await this.db.query.memberships.findMany({ where: and(eq(memberships.organizationId, orgId), inArray(memberships.role, ["owner", "admin"])), columns: { userId: true } });
    for (const a of admins) {
      if (a.userId === userId) continue;
      await this.notifications.notifyDirect({
        orgId,
        receiverId: a.userId,
        actorId: userId,
        entityType: "invoice",
        entityId: id,
        verb: "invoice_review_requested",
        title: `Review & issue ${inv.number} — ${inv.title} (${inv.currency} ${inv.total.toFixed(2)})`,
        body: `For ${inv.company?.name ?? inv.contact?.name ?? "the client"}. Approve to issue it, or return it to draft with a note.`,
        data: { invoiceId: id, approval: pendingApproval("invoice_issue") },
      });
    }
    return this.get(orgId, id);
  }

  /** Back to draft from review (admin), with the reason attached to the trail. */
  async returnToDraft(orgId: string, userId: string, id: string, note?: string | null) {
    const inv = await this.get(orgId, id);
    if (inv.status !== "review") throw new BadRequestException("Only an invoice in review can be returned");
    await this.db.update(invoices).set({ status: "draft", updatedAt: new Date() }).where(eq(invoices.id, id));
    await this.notifications.resolveApproval("invoice", id, "rejected", note, userId);
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "returned_to_draft", changes: [{ field: "status", from: "review", to: "draft" }, ...(note?.trim() ? [{ field: "note", from: null, to: note.trim() }] : [])] });
    if (inv.submittedById && inv.submittedById !== userId) {
      await this.notifications.notifyDirect({ orgId, receiverId: inv.submittedById, actorId: userId, entityType: "invoice", entityId: id, verb: "invoice_returned", title: `${inv.number} was returned to draft`, body: note?.trim() || "Please check it and submit again.", data: { invoiceId: id } });
    }
    return this.get(orgId, id);
  }

  /**
   * Row 139: an issued invoice never changes. A revision copies it into
   * version n+1 (same number, back in draft), moves any payments and the
   * hours / expenses it billed across, and marks the old version superseded
   * — its link keeps working, pointing at the replacement once that is sent.
   */
  async revise(orgId: string, userId: string, id: string, reason: string) {
    const inv = await this.get(orgId, id);
    if (!["sent", "viewed", "partially_paid", "paid"].includes(inv.status)) throw new BadRequestException("Only an issued invoice can be revised — drafts are simply edited");
    if (inv.supersededById) throw new BadRequestException("This version was already revised");
    if (!reason?.trim()) throw new BadRequestException("Say what changed — it goes on the record");
    const now = new Date();
    const newId = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invoices)
        .values({
          organizationId: orgId,
          createdById: userId,
          number: inv.number,
          version: inv.version + 1,
          revisionOfId: inv.id,
          revisionReason: reason.trim(),
          title: inv.title,
          companyId: inv.company?.id ?? null,
          contactId: inv.contact?.id ?? null,
          projectId: inv.project?.id ?? null,
          dealId: inv.dealId,
          estimateId: inv.estimateId,
          proposalId: inv.proposalId,
          scheduleId: inv.schedule?.id ?? null,
          status: "draft",
          currency: inv.currency,
          issueDate: inv.issueDate,
          dueDate: inv.dueDate,
          notes: inv.notes,
          subtotal: inv.subtotal,
          discountPercent: inv.discountPercent,
          discountAmount: inv.discountAmount,
          taxRate: inv.taxRate,
          taxAmount: inv.taxAmount,
          total: inv.total,
          onlinePayments: inv.onlinePayments,
        })
        .returning({ id: invoices.id });
      const nid = row!.id;
      if (inv.items.length) await tx.insert(invoiceItems).values(itemRows(orgId, nid, inv.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, stageId: i.stageId, billedPct: i.billedPct }))));
      // Money and billed work follow the live version.
      await tx.update(invoicePayments).set({ invoiceId: nid }).where(eq(invoicePayments.invoiceId, inv.id));
      await tx.update(expenses).set({ invoiceId: nid, updatedAt: now }).where(eq(expenses.invoiceId, inv.id));
      await tx.update(timeEntries).set({ invoiceId: nid, updatedAt: now }).where(eq(timeEntries.invoiceId, inv.id));
      await tx.update(invoices).set({ status: "superseded", supersededById: nid, amountPaid: 0, updatedAt: now }).where(eq(invoices.id, inv.id));
      // Carry the paid total, but the new version stays a draft until it is issued again.
      const [sum] = await tx.select({ n: sql<number>`coalesce(sum(${invoicePayments.amount}), 0)::float` }).from(invoicePayments).where(eq(invoicePayments.invoiceId, nid));
      await tx.update(invoices).set({ amountPaid: round2(sum?.n ?? 0) }).where(eq(invoices.id, nid));
      return nid;
    });
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: inv.id, action: "superseded", changes: [{ field: "version", from: String(inv.version), to: String(inv.version + 1) }, { field: "reason", from: null, to: reason.trim() }] });
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: newId, action: "revised_from", changes: [{ field: "revisionOf", from: null, to: inv.id }] });
    return this.get(orgId, newId);
  }

  /** Every version of a number, oldest first. */
  async versions(orgId: string, id: string) {
    const inv = await this.get(orgId, id);
    const rows = await this.db.query.invoices.findMany({ where: and(eq(invoices.organizationId, orgId), eq(invoices.number, inv.number)), columns: { id: true, version: true, status: true, total: true, issueDate: true, sentAt: true, revisionReason: true, createdAt: true }, orderBy: asc(invoices.version) });
    return rows.map((r) => ({ id: r.id, version: r.version, status: r.status, total: r.total, issueDate: r.issueDate, sentAt: r.sentAt, revisionReason: r.revisionReason, createdAt: r.createdAt, current: r.id === inv.id }));
  }

  /* ---------------- read ---------------- */

  async list(orgId: string, opts: { status?: string; companyId?: string; projectId?: string; scheduleId?: string } = {}) {
    const filters = [eq(invoices.organizationId, orgId), isNull(invoices.archivedAt)];
    // Row 139: old versions stay out of the list unless asked for by status.
    if (opts.status !== "superseded") filters.push(ne(invoices.status, "superseded"));
    if (opts.companyId) filters.push(eq(invoices.companyId, opts.companyId));
    if (opts.scheduleId) filters.push(eq(invoices.scheduleId, opts.scheduleId));
    if (opts.projectId) filters.push(eq(invoices.projectId, opts.projectId));
    if (opts.status === "outstanding") filters.push(inArray(invoices.status, OPEN));
    else if (opts.status === "overdue") filters.push(inArray(invoices.status, OPEN), lt(invoices.dueDate, new Date()));
    else if (opts.status && opts.status !== "all") filters.push(eq(invoices.status, opts.status as InvoiceStatus));
    const rows = await this.db.query.invoices.findMany({
      where: and(...filters),
      with: { company: { columns: { id: true, name: true } }, contact: { columns: { id: true, firstName: true, lastName: true, email: true } }, project: { columns: { id: true, name: true } }, schedule: { columns: { id: true, name: true, nextRunAt: true, status: true } } },
      orderBy: [desc(invoices.issueDate), desc(invoices.createdAt)],
    });
    return rows.map((r) => shape(r));
  }

  /** Header tiles for the list page. */
  async summary(orgId: string) {
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const open = await this.db
      .select({ total: invoices.total, paid: invoices.amountPaid, due: invoices.dueDate })
      .from(invoices)
      .where(and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), inArray(invoices.status, OPEN)));
    let outstanding = 0;
    let overdue = 0;
    let overdueCount = 0;
    for (const r of open) {
      const bal = Math.max(0, r.total - r.paid);
      outstanding += bal;
      if (r.due && r.due < now) {
        overdue += bal;
        overdueCount++;
      }
    }
    const [paid] = await this.db
      .select({ n: sql<number>`coalesce(sum(${invoicePayments.amount}), 0)::float` })
      .from(invoicePayments)
      .where(and(eq(invoicePayments.organizationId, orgId), gte(invoicePayments.paidAt, since)));
    const [drafts] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), eq(invoices.status, "draft")));
    const [review] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), eq(invoices.status, "review")));
    return { outstanding: round2(outstanding), overdue: round2(overdue), overdueCount, paidLast30: round2(paid?.n ?? 0), drafts: drafts?.n ?? 0, inReview: review?.n ?? 0, openCount: open.length };
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, id), eq(invoices.organizationId, orgId)),
      with: {
        company: { columns: { id: true, name: true } },
        contact: { columns: { id: true, firstName: true, lastName: true, email: true } },
        project: { columns: { id: true, name: true } },
        schedule: { columns: { id: true, name: true, nextRunAt: true, status: true } },
        deal: { columns: { id: true, title: true } },
        createdBy: { columns: { id: true, name: true } },
        items: { orderBy: asc(invoiceItems.position) },
        payments: { orderBy: desc(invoicePayments.paidAt), with: { recordedBy: { columns: { id: true, name: true } } } },
      },
    });
    if (!row) throw new NotFoundException("Invoice not found");
    return {
      ...shape(row),
      deal: row.deal ? { id: row.deal.id, title: row.deal.title } : null,
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
      items: row.items.map(shapeItem),
      payments: row.payments.map((p) => ({
        id: p.id,
        amount: p.amount,
        method: p.method,
        paidAt: p.paidAt,
        reference: p.reference,
        note: p.note,
        provider: p.provider,
        providerRef: p.providerRef,
        recordedBy: p.recordedBy ? { id: p.recordedBy.id, name: p.recordedBy.name } : null,
      })),
    };
  }

  /** Row 129: the "Pay now" button can be turned off per invoice at any stage (e.g. a retainer settled by standing order). */
  async setOnlinePayments(orgId: string, userId: string, id: string, enabled: boolean) {
    const inv = await this.get(orgId, id);
    if (inv.onlinePayments === enabled) return inv;
    await this.db.update(invoices).set({ onlinePayments: enabled, updatedAt: new Date() }).where(eq(invoices.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "updated", changes: [{ field: "onlinePayments", from: String(inv.onlinePayments), to: String(enabled) }] });
    return this.get(orgId, id);
  }

  /* ---------------- write ---------------- */

  async create(orgId: string, userId: string, dto: CreateInvoiceDto) {
    await this.assertLinks(orgId, dto);
    let seed: Partial<InvoiceDto> & { estimateId?: string; proposalId?: string } = {};

    if (dto.fromEstimateId) {
      const est = await this.db.query.estimates.findFirst({
        where: and(eq(estimates.id, dto.fromEstimateId), eq(estimates.organizationId, orgId)),
        with: { items: { orderBy: asc(estimateItems.position) } },
      });
      if (!est) throw new BadRequestException("Estimate not found in this organization");
      seed = {
        estimateId: est.id,
        title: est.title,
        companyId: est.companyId,
        contactId: est.contactId,
        dealId: est.dealId,
        currency: est.currency,
        taxRate: est.taxRate,
        notes: est.notes,
        items: est.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })),
      };
    } else if (dto.fromProposalId) {
      const p = await this.db.query.proposals.findFirst({ where: and(eq(proposals.id, dto.fromProposalId), eq(proposals.organizationId, orgId)) });
      if (!p) throw new BadRequestException("Proposal not found in this organization");
      seed = {
        proposalId: p.id,
        title: p.title,
        companyId: p.companyId,
        contactId: p.contactId,
        dealId: p.dealId,
        currency: p.currency,
        items: [{ description: `${p.number} — ${p.title}`, quantity: 1, unitPrice: p.total }],
      };
    }
    if (dto.projectId) {
      const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, dto.projectId), eq(projects.organizationId, orgId)) });
      if (!project) throw new BadRequestException("Project not found in this organization");
      seed.title ??= project.name;
      seed.companyId ??= project.companyId ?? undefined;
      seed.currency ??= project.currency;
    }

    // Explicit fields win over what the source suggested.
    // Row 139: workspace defaults (terms, tax, due days, currency) apply unless the caller says otherwise.
    const cfg = await this.settings(orgId);
    const title = (dto.title?.trim() || seed.title || "Invoice").slice(0, 255);
    const items = dto.items ?? seed.items ?? [];
    const taxRate = dto.taxRate ?? seed.taxRate ?? cfg.defaultTaxRate;
    const discountPercent = dto.discountPercent ?? 0;
    const totals = computeTotals(items, discountPercent, taxRate);
    const issueDate = dto.issueDate ? new Date(dto.issueDate) : new Date();
    const dueDate = dto.dueDate ? new Date(dto.dueDate) : new Date(issueDate.getTime() + cfg.defaultDueDays * 86_400_000);

    for (let attempt = 0; attempt < 3; attempt++) {
      const number = await this.nextNumber(orgId);
      try {
        const id = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(invoices)
            .values({
              organizationId: orgId,
              createdById: userId || null,
              number,
              title,
              companyId: dto.companyId !== undefined ? dto.companyId : (seed.companyId ?? null),
              contactId: dto.contactId !== undefined ? dto.contactId : (seed.contactId ?? null),
              projectId: dto.projectId ?? null,
              dealId: dto.dealId !== undefined ? dto.dealId : (seed.dealId ?? null),
              estimateId: seed.estimateId ?? null,
              proposalId: seed.proposalId ?? null,
              scheduleId: dto.scheduleId ?? null,
              currency: (dto.currency ?? seed.currency ?? cfg.defaultCurrency).toUpperCase(),
              issueDate,
              dueDate,
              notes: dto.notes !== undefined ? dto.notes : (seed.notes ?? (cfg.defaultNotes || null)),
              taxRate,
              discountPercent,
              ...totals,
            })
            .returning();
          if (items.length) await tx.insert(invoiceItems).values(itemRows(orgId, row!.id, items));
          return row!.id;
        });
        await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "created", changes: [{ field: "number", from: null, to: number }] });
        return this.get(orgId, id);
      } catch (err) {
        if (!String((err as Error).message).includes("invoices_org_number_uq") || attempt === 2) throw err;
      }
    }
    throw new BadRequestException("Could not allocate an invoice number");
  }

  /** Header and lines are replaced together; totals are recomputed here, never trusted from the client. */
  async update(orgId: string, userId: string, id: string, dto: InvoiceDto) {
    const before = await this.get(orgId, id);
    if (before.status !== "draft") throw new BadRequestException("Only draft invoices can be edited — move it back to draft first");
    await this.assertLinks(orgId, dto);

    const items = dto.items ?? before.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, stageId: i.stageId, billedPct: i.billedPct }));
    const taxRate = dto.taxRate ?? before.taxRate;
    const discountPercent = dto.discountPercent ?? before.discountPercent;
    const totals = computeTotals(items, discountPercent, taxRate);

    await this.db.transaction(async (tx) => {
      const patch: Record<string, unknown> = { ...totals, taxRate, discountPercent, updatedAt: new Date() };
      if (dto.title !== undefined) patch.title = dto.title.trim() || before.title;
      for (const k of ["companyId", "contactId", "projectId", "dealId", "notes"] as const) if (dto[k] !== undefined) patch[k] = dto[k];
      if (dto.currency !== undefined) patch.currency = dto.currency.toUpperCase();
      if (dto.issueDate !== undefined) patch.issueDate = dto.issueDate ? new Date(dto.issueDate) : new Date();
      if (dto.dueDate !== undefined) patch.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
      await tx.update(invoices).set(patch).where(eq(invoices.id, id));
      if (dto.items) {
        await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, id));
        if (items.length) await tx.insert(invoiceItems).values(itemRows(orgId, id, items));
      }
    });
    if (Math.abs(totals.total - before.total) > EPS) {
      await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "updated", changes: [{ field: "total", from: before.total, to: totals.total }] });
    }
    return this.get(orgId, id);
  }

  /**
   * Sending mints the client link and locks the lines. Nothing is emailed (no
   * mail provider wired for invoices yet); the link is shown to copy by hand.
   */
  async send(orgId: string, userId: string, id: string, opts: { system?: boolean } = {}) {
    const inv = await this.get(orgId, id);
    if (inv.status !== "draft" && inv.status !== "review") throw new BadRequestException("Only a draft can be sent");
    // Row 139: when the workspace insists on review, even admins go draft → review → issued (schedules are exempt).
    if (inv.status === "draft" && !opts.system && (await this.settings(orgId)).requireReview) throw new BadRequestException("This workspace requires review before issuing — submit it for review first");
    if (!inv.items.length) throw new BadRequestException("Add at least one line item before sending");
    if (inv.total <= 0) throw new BadRequestException("The invoice total must be greater than zero");
    const now = new Date();
    // Row 139: a revision inherits the previous version's client link so the old URL shows the new document.
    const prev = inv.revisionOfId ? await this.db.query.invoices.findFirst({ where: eq(invoices.id, inv.revisionOfId), columns: { token: true } }) : null;
    let token = inv.token ?? randomBytes(24).toString("hex");
    if (prev?.token) {
      await this.db.update(invoices).set({ token: null }).where(eq(invoices.id, inv.revisionOfId!));
      token = prev.token;
    }
    await this.db
      .update(invoices)
      .set({ status: "sent", sentAt: now, token, issuedById: userId || null, updatedAt: now })
      .where(eq(invoices.id, id));
    if (inv.status === "review") await this.notifications.resolveApproval("invoice", id, "approved", null, userId);
    // A re-issued revision may already carry payments: let them set the status (partially paid / paid).
    if (inv.amountPaid > EPS) await this.syncPaid(this.db, id);
    await this.activity.record({ orgId, actorId: userId || null, entityType: "invoice", entityId: id, action: opts.system ? "auto_sent" : "sent", changes: [{ field: "status", from: inv.status, to: "sent" }] });
    return this.get(orgId, id);
  }

  /** Back to draft is allowed until money has been recorded. */
  async reopen(orgId: string, userId: string, id: string) {
    const inv = await this.get(orgId, id);
    if (!["sent", "viewed", "void"].includes(inv.status)) throw new BadRequestException(`Cannot reopen a ${inv.status.replace("_", " ")} invoice`);
    if (inv.amountPaid > EPS) throw new BadRequestException("Payments have been recorded — remove them first");
    await this.db.update(invoices).set({ status: "draft", voidedAt: null, voidReason: null, updatedAt: new Date() }).where(eq(invoices.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "reopened", changes: [{ field: "status", from: inv.status, to: "draft" }] });
    return this.get(orgId, id);
  }

  async void(orgId: string, userId: string, id: string, reason?: string | null) {
    const inv = await this.get(orgId, id);
    if (inv.status === "void") return inv;
    if (inv.status === "paid" || inv.amountPaid > EPS) throw new BadRequestException("An invoice with payments can't be voided — remove the payments first");
    await this.db.update(invoices).set({ status: "void", voidedAt: new Date(), voidReason: reason?.trim() || null, updatedAt: new Date() }).where(eq(invoices.id, id));
    // Row 160: expenses billed on a voided invoice become billable again.
    await this.db.update(expenses).set({ invoiceId: null, updatedAt: new Date() }).where(eq(expenses.invoiceId, id));
    await this.db.update(timeEntries).set({ invoiceId: null, updatedAt: new Date() }).where(eq(timeEntries.invoiceId, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "voided", changes: [{ field: "status", from: inv.status, to: "void" }] });
    return this.get(orgId, id);
  }

  /**
   * Partial payments add up; paying past the balance is refused rather than
   * silently absorbed. `userId` is null when Stripe settles the invoice
   * (row 129); a providerRef that was already recorded is a no-op so a
   * replayed webhook and the return-page confirm cannot both count.
   */
  async recordPayment(orgId: string, userId: string | null, id: string, dto: PaymentDto) {
    const inv = await this.get(orgId, id);
    if (dto.providerRef) {
      const dup = await this.db.query.invoicePayments.findFirst({ where: eq(invoicePayments.providerRef, dto.providerRef), columns: { id: true } });
      if (dup) return inv;
    }
    if (inv.status === "draft") throw new BadRequestException("Send the invoice before recording a payment");
    if (inv.status === "void") throw new BadRequestException("This invoice is void");
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException("Amount must be greater than zero");
    const balance = round2(inv.total - inv.amountPaid);
    if (amount > balance + EPS) throw new BadRequestException(`That is more than the balance due (${inv.currency} ${balance.toFixed(2)})`);

    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    const paymentId = await this.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(invoicePayments)
        .values({
          organizationId: orgId,
          invoiceId: id,
          amount,
          method: dto.method ?? "bank_transfer",
          paidAt,
          reference: dto.reference?.trim() || null,
          note: dto.note?.trim() || null,
          provider: dto.provider ?? null,
          providerRef: dto.providerRef ?? null,
          recordedById: userId,
        })
        .returning({ id: invoicePayments.id });
      await this.syncPaid(tx, id);
      return p!.id;
    });
    // Row 162: income is split into the Profit First buckets the moment it lands.
    await this.profitFirst.allocatePayment(orgId, userId, { id: paymentId, invoiceId: id, amount, paidAt });
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: dto.provider ? "paid_online" : "payment_recorded", changes: [{ field: "amountPaid", from: inv.amountPaid, to: round2(inv.amountPaid + amount) }] });
    return this.get(orgId, id);
  }

  async removePayment(orgId: string, userId: string, id: string, paymentId: string) {
    const inv = await this.get(orgId, id);
    const p = inv.payments.find((x) => x.id === paymentId);
    if (!p) throw new NotFoundException("Payment not found");
    await this.profitFirst.unallocatePayment(orgId, paymentId);
    await this.db.transaction(async (tx) => {
      await tx.delete(invoicePayments).where(and(eq(invoicePayments.id, paymentId), eq(invoicePayments.organizationId, orgId)));
      await this.syncPaid(tx, id);
    });
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "payment_removed", changes: [{ field: "amountPaid", from: inv.amountPaid, to: round2(inv.amountPaid - p.amount) }] });
    return this.get(orgId, id);
  }

  async archive(orgId: string, userId: string, id: string) {
    await this.get(orgId, id);
    await this.db.update(invoices).set({ archivedAt: new Date() }).where(eq(invoices.id, id));
    await this.db.update(expenses).set({ invoiceId: null, updatedAt: new Date() }).where(eq(expenses.invoiceId, id));
    await this.db.update(timeEntries).set({ invoiceId: null, updatedAt: new Date() }).where(eq(timeEntries.invoiceId, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: id, action: "archived" });
    return { id, archived: true };
  }

  /* ---------------- PDF ---------------- */

  async pdf(orgId: string, id: string) {
    const inv = await this.get(orgId, id);
    return { bytes: await this.render(orgId, inv), filename: `${inv.number}.pdf` };
  }

  private async render(orgId: string, inv: Awaited<ReturnType<InvoicesService["get"]>>) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true, brandColor: true, brandFooter: true } });
    const company = inv.company ? await this.db.query.companies.findFirst({ where: eq(companies.id, inv.company.id), columns: { name: true, email: true, address: true } }) : null;
    return renderInvoicePdf({
      number: inv.number,
      title: inv.title,
      status: inv.status,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      currency: inv.currency,
      billTo: { company: company?.name ?? inv.company?.name, contact: inv.contact?.name, email: inv.contact?.email ?? company?.email, address: company?.address },
      project: inv.project?.name,
      items: inv.items,
      subtotal: inv.subtotal,
      discountPercent: inv.discountPercent,
      discountAmount: inv.discountAmount,
      taxRate: inv.taxRate,
      taxAmount: inv.taxAmount,
      total: inv.total,
      amountPaid: inv.amountPaid,
      notes: inv.notes,
      brand: { color: org?.brandColor ?? "#6366f1", orgName: org?.name ?? "", footer: org?.brandFooter },
    });
  }

  /* ---------------- public (client link) ---------------- */

  private async byToken(token: string) {
    if (!token || token.length < 16) throw new NotFoundException("This link is not valid");
    const row = await this.db.query.invoices.findFirst({ where: and(eq(invoices.token, token), isNull(invoices.archivedAt)), columns: { id: true, organizationId: true, status: true, viewedAt: true, viewCount: true, createdById: true, number: true, title: true, onlinePayments: true } });
    if (!row || row.status === "draft" || row.status === "review") throw new NotFoundException("This link is not valid");
    return row;
  }

  /** Row 129: the Stripe service resolves the client link the same way the public page does. */
  async resolveToken(token: string) {
    const row = await this.byToken(token);
    return { ...(await this.get(row.organizationId, row.id)), organizationId: row.organizationId };
  }

  /** Row 129: a webhook carries no org context, only the invoice id from the session metadata. */
  async findAnyOrg(id: string) {
    const row = await this.db.query.invoices.findFirst({ where: and(eq(invoices.id, id), isNull(invoices.archivedAt)), columns: { organizationId: true, createdById: true } });
    if (!row) return null;
    return { ...(await this.get(row.organizationId, id)), organizationId: row.organizationId, createdById: row.createdById };
  }

  /** Whether the client link should offer "Pay now": keys present, the invoice allows it, and there is a balance. */
  payOnline(inv: { status: string; onlinePayments: boolean; balanceDue: number }) {
    return stripeConfigured() && inv.onlinePayments && OPEN.includes(inv.status as InvoiceStatus) && inv.balanceDue > EPS;
  }

  /** Opening the link counts as a view; the first one is announced to whoever issued it. */
  async view(token: string) {
    const row = await this.byToken(token);
    const now = new Date();
    const first = !row.viewedAt;
    await this.db
      .update(invoices)
      .set({ viewedAt: row.viewedAt ?? now, lastViewedAt: now, viewCount: row.viewCount + 1, ...(row.status === "sent" ? { status: "viewed" as const } : {}), updatedAt: now })
      .where(eq(invoices.id, row.id));
    if (first && row.createdById) {
      await this.notifications.notifyDirect({
        orgId: row.organizationId,
        receiverId: row.createdById,
        entityType: "invoice",
        entityId: row.id,
        verb: "invoice_viewed",
        title: `Invoice ${row.number} was opened by the client`,
        body: row.title,
        data: { invoiceId: row.id },
      });
    }
    const inv = await this.get(row.organizationId, row.id);
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, row.organizationId), columns: { name: true, brandColor: true, brandLogoUrl: true, brandFooter: true } });
    const company = inv.company ? await this.db.query.companies.findFirst({ where: eq(companies.id, inv.company.id), columns: { name: true, address: true, email: true } }) : null;
    return {
      token,
      invoice: {
        number: inv.number,
        version: inv.version,
        superseded: inv.status === "superseded",
        title: inv.title,
        status: inv.status,
        overdue: inv.overdue,
        currency: inv.currency,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        notes: inv.notes,
        items: inv.items,
        subtotal: inv.subtotal,
        discountPercent: inv.discountPercent,
        discountAmount: inv.discountAmount,
        taxRate: inv.taxRate,
        taxAmount: inv.taxAmount,
        total: inv.total,
        amountPaid: inv.amountPaid,
        balanceDue: inv.balanceDue,
        paidAt: inv.paidAt,
        billTo: { company: company?.name ?? inv.company?.name ?? null, contact: inv.contact?.name ?? null, email: inv.contact?.email ?? company?.email ?? null, address: company?.address ?? null },
        project: inv.project?.name ?? null,
        payments: inv.payments.map((p) => ({ amount: p.amount, method: p.method, paidAt: p.paidAt, provider: p.provider })),
        payOnline: this.payOnline(inv),
      },
      from: { name: org?.name ?? "", color: org?.brandColor ?? "#6366f1", logoUrl: org?.brandLogoUrl ?? null, footer: org?.brandFooter ?? null },
    };
  }

  async publicPdf(token: string) {
    const row = await this.byToken(token);
    const inv = await this.get(row.organizationId, row.id);
    return { bytes: await this.render(row.organizationId, inv), filename: `${inv.number}.pdf` };
  }

  /* ---------------- helpers ---------------- */

  /** amountPaid / status / paidAt follow the payments table; never hand-edited. */
  private async syncPaid(tx: Pick<DB, "select" | "update">, id: string) {
    const [sum] = await tx.select({ n: sql<number>`coalesce(sum(${invoicePayments.amount}), 0)::float` }).from(invoicePayments).where(eq(invoicePayments.invoiceId, id));
    const [inv] = await tx.select({ total: invoices.total, status: invoices.status, viewedAt: invoices.viewedAt }).from(invoices).where(eq(invoices.id, id));
    const paid = round2(sum?.n ?? 0);
    const settled = paid >= inv!.total - EPS;
    const status: InvoiceStatus = settled ? "paid" : paid > EPS ? "partially_paid" : inv!.viewedAt ? "viewed" : "sent";
    await tx.update(invoices).set({ amountPaid: paid, status, paidAt: settled ? new Date() : null, updatedAt: new Date() }).where(eq(invoices.id, id));
  }

  /** Row 139: prefix + zero-padded counter from Settings; a custom "next number" restarts the sequence. */
  private async nextNumber(orgId: string) {
    const cfg = await this.settings(orgId);
    const used = await this.highestNumber(orgId, cfg.prefix);
    const n = Math.max(used + 1, cfg.nextNumber ?? 1);
    if (cfg.nextNumber != null) await this.db.update(organizations).set({ invoicing: { ...cfg, nextNumber: null } }).where(eq(organizations.id, orgId));
    return `${cfg.prefix}${String(n).padStart(cfg.padding, "0")}`;
  }

  private async assertLinks(orgId: string, dto: Partial<InvoiceDto>) {
    const checks: [string | null | undefined, () => Promise<unknown>, string][] = [
      [dto.companyId, () => this.db.query.companies.findFirst({ where: and(eq(companies.id, dto.companyId!), eq(companies.organizationId, orgId)) }), "Company"],
      [dto.contactId, () => this.db.query.contacts.findFirst({ where: and(eq(contacts.id, dto.contactId!), eq(contacts.organizationId, orgId)) }), "Contact"],
      [dto.projectId, () => this.db.query.projects.findFirst({ where: and(eq(projects.id, dto.projectId!), eq(projects.organizationId, orgId)) }), "Project"],
      [dto.dealId, () => this.db.query.deals.findFirst({ where: and(eq(deals.id, dto.dealId!), eq(deals.organizationId, orgId)) }), "Deal"],
    ];
    for (const [id, find, label] of checks) if (id && !(await find())) throw new BadRequestException(`${label} not found in this organization`);
  }
}

export function computeTotals(items: InvoiceItemDto[], discountPercent: number, taxRate: number) {
  const subtotal = round2(items.reduce((a, i) => a + i.quantity * i.unitPrice, 0));
  const discountAmount = round2(subtotal * (Math.min(100, Math.max(0, discountPercent)) / 100));
  const taxable = round2(subtotal - discountAmount);
  const taxAmount = round2(taxable * (Math.max(0, taxRate) / 100));
  return { subtotal, discountAmount, taxAmount, total: round2(taxable + taxAmount) };
}

function itemRows(orgId: string, invoiceId: string, items: InvoiceItemDto[]) {
  return items.map((i, idx) => ({ organizationId: orgId, invoiceId, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, amount: round2(i.quantity * i.unitPrice), position: idx + 1, stageId: i.stageId ?? null, billedPct: i.billedPct ?? null }));
}

function shapeItem(i: typeof invoiceItems.$inferSelect) {
  return { id: i.id, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, amount: i.amount, stageId: i.stageId, billedPct: i.billedPct };
}

function shape(
  r: typeof invoices.$inferSelect & {
    company: { id: string; name: string } | null;
    contact: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null;
    project: { id: string; name: string } | null;
    schedule?: { id: string; name: string; nextRunAt: Date | null; status: string } | null;
  },
) {
  const balanceDue = round2(Math.max(0, r.total - r.amountPaid));
  const overdue = OPEN.includes(r.status) && Boolean(r.dueDate && r.dueDate < new Date());
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    status: r.status,
    overdue,
    currency: r.currency,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    notes: r.notes,
    subtotal: r.subtotal,
    discountPercent: r.discountPercent,
    discountAmount: r.discountAmount,
    taxRate: r.taxRate,
    taxAmount: r.taxAmount,
    total: r.total,
    amountPaid: r.amountPaid,
    balanceDue,
    token: r.token,
    sentAt: r.sentAt,
    viewedAt: r.viewedAt,
    lastViewedAt: r.lastViewedAt,
    viewCount: r.viewCount,
    paidAt: r.paidAt,
    voidedAt: r.voidedAt,
    voidReason: r.voidReason,
    onlinePayments: r.onlinePayments,
    version: r.version,
    revisionOfId: r.revisionOfId,
    supersededById: r.supersededById,
    revisionReason: r.revisionReason,
    submittedForReviewAt: r.submittedForReviewAt,
    submittedById: r.submittedById,
    issuedById: r.issuedById,
    estimateId: r.estimateId,
    proposalId: r.proposalId,
    dealId: r.dealId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    contact: r.contact ? { id: r.contact.id, name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(" "), email: r.contact.email } : null,
    project: r.project ? { id: r.project.id, name: r.project.name } : null,
    schedule: r.schedule ? { id: r.schedule.id, name: r.schedule.name, nextRunAt: r.schedule.nextRunAt, status: r.schedule.status } : null,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
