import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { accountingLinks, accountingRuns, invoicePayments, invoices, memberships, organizations, type AccountingProviderKey, type AccountingSettings } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { IntegrationsService } from "../integrations/integrations.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { DemoProvider } from "./demo.provider.js";
import { isoDay, ProviderError, round2, type AccountingProvider, type InvoicePayload } from "./provider.js";
import { QuickBooksProvider } from "./quickbooks.provider.js";
import { XeroProvider } from "./xero.provider.js";

export const DEFAULT_ACCOUNTING: AccountingSettings = {
  provider: null,
  autoSync: true,
  syncPayments: true,
  xeroSalesAccountCode: "200",
  xeroPaymentAccountCode: "090",
  quickbooksItemName: "Services",
};

/** Statuses that exist as documents in the ledger. Drafts are ours alone. */
const SYNCABLE = ["sent", "viewed", "partially_paid", "paid", "void", "superseded"] as const;

type Link = typeof accountingLinks.$inferSelect;
type LoadedInvoice = NonNullable<Awaited<ReturnType<AccountingService["loadInvoices"]>>[number]>;

interface Counters { created: number; updated: number; unchanged: number; conflicts: number; errors: number }

/**
 * Row 131: push issued invoices and recorded payments to the ledger. The
 * rules that matter:
 *  - one direction: we write to the ledger, we never import its edits;
 *  - a record whose ledger copy changed since we last pushed is never
 *    overwritten — it is flagged (drifted: only they changed; conflict: both
 *    changed) and a human picks a side on Finance › Accounting;
 *  - payments are append-only over there, so a payment removed here is
 *    flagged for a manual fix rather than deleted remotely.
 */
@Injectable()
export class AccountingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountingService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly integrations: IntegrationsService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    setTimeout(() => void this.sweep(), 45_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Hourly: every workspace with a provider and auto-sync on. */
  async sweep() {
    try {
      const orgs = await this.db.query.organizations.findMany({ columns: { id: true, accounting: true } });
      for (const o of orgs) {
        const s = { ...DEFAULT_ACCOUNTING, ...(o.accounting ?? {}) };
        if (s.provider && s.autoSync) await this.run(o.id, "auto", null).catch((err) => this.logger.warn(`auto sync ${o.id}: ${(err as Error).message}`));
      }
    } catch (err) {
      this.logger.warn(`accounting sweep failed: ${(err as Error).message}`);
    }
  }

  /* ---------------- settings ---------------- */

  async settings(orgId: string): Promise<AccountingSettings> {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { accounting: true } });
    return { ...DEFAULT_ACCOUNTING, ...(org?.accounting ?? {}) };
  }

  async updateSettings(orgId: string, userId: string, patch: Partial<AccountingSettings>) {
    const before = await this.settings(orgId);
    const next = { ...before, ...patch };
    if (next.provider && next.provider !== "demo") {
      const conn = await this.integrations.connection(orgId, next.provider);
      if (!conn) throw new BadRequestException(`Connect ${next.provider === "xero" ? "Xero" : "QuickBooks"} first`);
    }
    await this.db.update(organizations).set({ accounting: next, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    if (before.provider !== next.provider) {
      await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "accounting_provider_changed", changes: [{ field: "provider", from: before.provider, to: next.provider }] });
    }
    return next;
  }

  /* ---------------- overview ---------------- */

  async overview(orgId: string) {
    const settings = await this.settings(orgId);
    const providers = (await this.integrations.list(orgId)).filter((p) => p.kind === "accounting");
    const [links, runs] = await Promise.all([
      this.db.query.accountingLinks.findMany({ where: eq(accountingLinks.organizationId, orgId), with: { resolvedBy: { columns: { id: true, name: true } } }, orderBy: [desc(accountingLinks.updatedAt)] }),
      this.db.query.accountingRuns.findMany({ where: eq(accountingRuns.organizationId, orgId), with: { startedBy: { columns: { id: true, name: true } } }, orderBy: [desc(accountingRuns.startedAt)], limit: 10 }),
    ]);
    const invoiceIds = links.filter((l) => l.entityType === "invoice").map((l) => l.entityId);
    const invRows = invoiceIds.length ? await this.db.select({ id: invoices.id, number: invoices.number, title: invoices.title, status: invoices.status, total: invoices.total }).from(invoices).where(inArray(invoices.id, invoiceIds)) : [];
    const invBy = new Map(invRows.map((i) => [i.id, i]));
    const provider = settings.provider ? await this.provider(orgId, settings).catch(() => null) : null;
    const shaped = links.map((l) => {
      const inv = l.entityType === "invoice" ? invBy.get(l.entityId) : undefined;
      return {
        id: l.id,
        provider: l.provider,
        entityType: l.entityType,
        entityId: l.entityId,
        remoteId: l.remoteId,
        remoteLabel: l.remoteLabel,
        remoteUrl: l.entityType === "invoice" && provider && provider.key === l.provider ? provider.invoiceUrl(l.remoteId) : null,
        status: l.status,
        error: l.error,
        conflict: l.conflict,
        syncedAt: l.syncedAt?.toISOString() ?? null,
        resolvedAt: l.resolvedAt?.toISOString() ?? null,
        resolvedBy: l.resolvedBy,
        invoice: inv ? { id: inv.id, number: inv.number, title: inv.title, status: inv.status, total: inv.total } : null,
      };
    });
    const pending = await this.pendingCount(orgId, settings);
    return {
      settings,
      providers,
      counts: {
        synced: links.filter((l) => l.status === "synced").length,
        drifted: links.filter((l) => l.status === "drifted").length,
        conflicts: links.filter((l) => l.status === "conflict").length,
        errors: links.filter((l) => l.status === "error").length,
        pending,
      },
      attention: shaped.filter((l) => l.status !== "synced"),
      links: shaped,
      runs: runs.map((r) => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null })),
      running: this.running.has(orgId),
    };
  }

  /** Invoices that would be pushed on the next run (sent, never linked). */
  private async pendingCount(orgId: string, settings: AccountingSettings) {
    if (!settings.provider) return 0;
    // Void-before-sync invoices never go over, so they are not "waiting".
    const rows = await this.db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), inArray(invoices.status, SYNCABLE.filter((x) => x !== "void" && x !== "superseded"))));
    if (!rows.length) return 0;
    const linked = await this.db.select({ entityId: accountingLinks.entityId }).from(accountingLinks).where(and(eq(accountingLinks.organizationId, orgId), eq(accountingLinks.provider, settings.provider), eq(accountingLinks.entityType, "invoice")));
    const has = new Set(linked.map((l) => l.entityId));
    return rows.filter((r) => !has.has(r.id)).length;
  }

  /** Row 131: what an invoice page shows — its link in the active ledger, if any. */
  async forInvoice(orgId: string, invoiceId: string) {
    const settings = await this.settings(orgId);
    if (!settings.provider) return null;
    const l = await this.db.query.accountingLinks.findFirst({ where: and(eq(accountingLinks.organizationId, orgId), eq(accountingLinks.provider, settings.provider), eq(accountingLinks.entityType, "invoice"), eq(accountingLinks.entityId, invoiceId)) });
    if (!l) return { provider: settings.provider, status: "pending" as const, remoteId: null, remoteLabel: null, remoteUrl: null, syncedAt: null, error: null, linkId: null };
    const provider = await this.provider(orgId, settings).catch(() => null);
    return { provider: settings.provider, status: l.status, remoteId: l.remoteId, remoteLabel: l.remoteLabel, remoteUrl: provider?.invoiceUrl(l.remoteId) ?? null, syncedAt: l.syncedAt?.toISOString() ?? null, error: l.error, linkId: l.id };
  }

  /* ---------------- the run ---------------- */

  async run(orgId: string, trigger: "manual" | "auto", userId: string | null, only?: { invoiceId?: string }) {
    const settings = await this.settings(orgId);
    if (!settings.provider) throw new BadRequestException("Choose an accounting provider first");
    if (this.running.has(orgId)) throw new BadRequestException("A sync is already running");
    this.running.add(orgId);
    const [run] = await this.db.insert(accountingRuns).values({ organizationId: orgId, provider: settings.provider, trigger, startedById: userId }).returning();
    const c: Counters = { created: 0, updated: 0, unchanged: 0, conflicts: 0, errors: 0 };
    let message: string | null = null;
    try {
      const provider = await this.provider(orgId, settings);
      const list = await this.loadInvoices(orgId, only?.invoiceId);
      const links = await this.db.query.accountingLinks.findMany({ where: and(eq(accountingLinks.organizationId, orgId), eq(accountingLinks.provider, provider.key)) });
      const linkOf = (type: string, id: string) => links.find((l) => l.entityType === type && l.entityId === id);
      const newConflicts: { number: string; status: "drifted" | "conflict"; reason: string }[] = [];

      for (const inv of list) {
        try {
          const customerId = await this.ensureCustomer(orgId, provider, inv, links);
          const payload = toPayload(inv, customerId);
          const hash = hashOf(payload);
          const link = linkOf("invoice", inv.id);

          if (!link) {
            if (payload.void) {
              c.unchanged++;
              continue; // voided before it ever reached the ledger: nothing to create
            }
            const ref = await provider.createInvoice(payload);
            const [row] = await this.db
              .insert(accountingLinks)
              .values({ organizationId: orgId, provider: provider.key, entityType: "invoice", entityId: inv.id, remoteId: ref.id, remoteLabel: ref.label ?? inv.number, remoteVersion: ref.version, localHash: hash, status: "synced", syncedAt: new Date() })
              .returning();
            links.push(row!);
            c.created++;
          } else if (link.status === "conflict") {
            c.conflicts++; // waiting on a human; leave it alone
          } else {
            const remote = await provider.getInvoice(link.remoteId);
            if (!remote) {
              await this.setError(link, `Not found in ${provider.label} any more — it may have been deleted there`);
              c.errors++;
              continue;
            }
            const localChanged = hash !== link.localHash;
            const remoteChanged = remote.version !== link.remoteVersion;
            if (!localChanged && !remoteChanged) {
              if (link.status === "error") await this.db.update(accountingLinks).set({ status: "synced", error: null, updatedAt: new Date() }).where(eq(accountingLinks.id, link.id));
              c.unchanged++;
            } else if (localChanged && !remoteChanged) {
              const ref = payload.void ? await provider.voidInvoice(link.remoteId) : await provider.updateInvoice(link.remoteId, payload);
              await this.db.update(accountingLinks).set({ remoteVersion: ref.version, remoteLabel: ref.label ?? link.remoteLabel, localHash: hash, status: "synced", error: null, conflict: null, syncedAt: new Date(), updatedAt: new Date() }).where(eq(accountingLinks.id, link.id));
              c.updated++;
            } else {
              const status = localChanged ? "conflict" : "drifted";
              const reason = localChanged ? `Edited both here and in ${provider.label} since the last sync` : `Edited in ${provider.label} since the last sync; unchanged here`;
              const theirs = { number: remote.number, total: remote.total, amountPaid: remote.amountPaid, status: remote.status, updatedAt: remote.updatedAt, version: remote.version };
              const ours = { number: inv.number, total: inv.total, amountPaid: inv.amountPaid, status: inv.status, updatedAt: inv.updatedAt.toISOString(), lines: inv.items.length };
              if (link.status !== status) newConflicts.push({ number: inv.number, status, reason });
              await this.db.update(accountingLinks).set({ status, conflict: { ours, theirs, detectedAt: new Date().toISOString(), reason }, updatedAt: new Date() }).where(eq(accountingLinks.id, link.id));
              c.conflicts++;
            }
          }

          if (settings.syncPayments) await this.pushPayments(orgId, provider, inv, customerId, links, linkOf, c);
        } catch (err) {
          c.errors++;
          const msg = err instanceof ProviderError ? err.message : (err as Error).message;
          const link = linkOf("invoice", inv.id);
          if (link) await this.setError(link, msg);
          else message = message ?? `${inv.number}: ${msg}`;
          this.logger.warn(`sync ${inv.number}: ${msg}`);
        }
      }

      // Payments removed here after they were pushed: append-only over there, so ask for a manual fix.
      const payIds = new Set(list.flatMap((i) => i.payments.map((p) => p.id)));
      for (const l of links.filter((x) => x.entityType === "payment" && x.status !== "error")) {
        if (!only && !payIds.has(l.entityId)) {
          await this.setError(l, `Payment was removed here after it was pushed — delete it in ${provider.label} by hand`);
          c.errors++;
        }
      }

      if (newConflicts.length) await this.notifyAdmins(orgId, provider.label, newConflicts);
    } catch (err) {
      message = (err as Error).message;
      c.errors++;
      this.logger.warn(`sync failed for ${orgId}: ${message}`);
    } finally {
      this.running.delete(orgId);
      await this.db.update(accountingRuns).set({ ...c, message, finishedAt: new Date() }).where(eq(accountingRuns.id, run!.id));
    }
    if (userId) await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "accounting_synced", changes: [{ field: "result", from: null, to: `${c.created} created, ${c.updated} updated, ${c.conflicts} flagged, ${c.errors} errors` }] });
    return { runId: run!.id, ...c, message };
  }

  private async pushPayments(orgId: string, provider: AccountingProvider, inv: LoadedInvoice, customerId: string, links: Link[], linkOf: (t: string, id: string) => Link | undefined, c: Counters) {
    const invLink = linkOf("invoice", inv.id);
    if (!invLink || invLink.status === "conflict" || invLink.status === "error") return;
    for (const p of inv.payments) {
      if (linkOf("payment", p.id)) continue;
      try {
        const ref = await provider.createPayment({ invoiceRemoteId: invLink.remoteId, customerRemoteId: customerId, amount: round2(p.amount), date: isoDay(p.paidAt), reference: p.reference, method: p.method });
        const [row] = await this.db
          .insert(accountingLinks)
          .values({ organizationId: orgId, provider: provider.key, entityType: "payment", entityId: p.id, remoteId: ref.id, remoteLabel: `${inv.number} · ${inv.currency} ${p.amount.toFixed(2)}`, remoteVersion: ref.version, localHash: null, status: "synced", syncedAt: new Date() })
          .returning();
        links.push(row!);
        c.created++;
        // The ledger applied the payment itself; refresh our baseline so that is not read as a human edit next time.
        const remote = await provider.getInvoice(invLink.remoteId);
        if (remote) {
          invLink.remoteVersion = remote.version;
          await this.db.update(accountingLinks).set({ remoteVersion: remote.version, updatedAt: new Date() }).where(eq(accountingLinks.id, invLink.id));
        }
      } catch (err) {
        c.errors++;
        const msg = err instanceof ProviderError ? err.message : (err as Error).message;
        await this.setError(invLink, `Payment of ${p.amount.toFixed(2)} failed: ${msg}`);
      }
    }
  }

  private async ensureCustomer(orgId: string, provider: AccountingProvider, inv: LoadedInvoice, links: Link[]) {
    const key = inv.companyId ?? inv.contactId ?? orgId;
    const existing = links.find((l) => l.entityType === "company" && l.entityId === key);
    if (existing) return existing.remoteId;
    const name = inv.company?.name ?? (inv.contact ? [inv.contact.firstName, inv.contact.lastName].filter(Boolean).join(" ") : "") ?? "";
    const label = name.trim() || "Unassigned client";
    const email = inv.company?.email ?? inv.contact?.email ?? null;
    const ref = (await provider.findCustomer(label)) ?? (await provider.createCustomer({ name: label, email }));
    const [row] = await this.db
      .insert(accountingLinks)
      .values({ organizationId: orgId, provider: provider.key, entityType: "company", entityId: key, remoteId: ref.id, remoteLabel: ref.label ?? label, remoteVersion: ref.version, status: "synced", syncedAt: new Date() })
      .onConflictDoUpdate({ target: [accountingLinks.organizationId, accountingLinks.provider, accountingLinks.entityType, accountingLinks.entityId], set: { remoteId: ref.id, remoteLabel: ref.label ?? label, updatedAt: new Date() } })
      .returning();
    links.push(row!);
    return ref.id;
  }

  private async setError(link: Link, error: string) {
    if (link.status === "error" && link.error === error) return;
    link.status = "error";
    link.error = error;
    await this.db.update(accountingLinks).set({ status: "error", error, updatedAt: new Date() }).where(eq(accountingLinks.id, link.id));
  }

  /* ---------------- resolution ---------------- */

  /**
   * ours: push our version over the ledger copy. theirs: keep the ledger
   * copy and stop nagging — nothing is pushed until the invoice changes here
   * again. retry: clear an error and try on the next run.
   */
  async resolve(orgId: string, userId: string, linkId: string, choice: "ours" | "theirs" | "retry") {
    const link = await this.db.query.accountingLinks.findFirst({ where: and(eq(accountingLinks.id, linkId), eq(accountingLinks.organizationId, orgId)) });
    if (!link) throw new NotFoundException("Link not found");
    const settings = await this.settings(orgId);
    if (choice === "retry") {
      if (link.entityType === "payment") {
        // The payment is gone here and the human says it is gone over there: nothing left to track.
        const still = await this.db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, link.entityId), columns: { id: true } });
        if (!still) {
          await this.db.delete(accountingLinks).where(eq(accountingLinks.id, link.id));
          return this.overview(orgId);
        }
      }
      await this.db.update(accountingLinks).set({ status: "synced", error: null, conflict: null, resolvedAt: new Date(), resolvedById: userId, updatedAt: new Date() }).where(eq(accountingLinks.id, link.id));
      return this.overview(orgId);
    }
    if (link.entityType !== "invoice") throw new BadRequestException("Only invoices can be resolved this way");
    const provider = await this.provider(orgId, settings);
    if (provider.key !== link.provider) throw new BadRequestException("That link belongs to a different provider");
    const [inv] = await this.loadInvoices(orgId, link.entityId);
    if (!inv) throw new NotFoundException("Invoice not found");
    const links = await this.db.query.accountingLinks.findMany({ where: and(eq(accountingLinks.organizationId, orgId), eq(accountingLinks.provider, provider.key), eq(accountingLinks.entityType, "company")) });
    const customerId = await this.ensureCustomer(orgId, provider, inv, links);
    const payload = toPayload(inv, customerId);
    const hash = hashOf(payload);
    if (choice === "ours") {
      const ref = payload.void ? await provider.voidInvoice(link.remoteId) : await provider.updateInvoice(link.remoteId, payload);
      await this.db.update(accountingLinks).set({ remoteVersion: ref.version, localHash: hash, status: "synced", error: null, conflict: null, syncedAt: new Date(), resolvedAt: new Date(), resolvedById: userId, updatedAt: new Date() }).where(eq(accountingLinks.id, link.id));
    } else {
      const remote = await provider.getInvoice(link.remoteId);
      if (!remote) throw new BadRequestException(`That invoice no longer exists in ${provider.label}`);
      await this.db.update(accountingLinks).set({ remoteVersion: remote.version, localHash: hash, status: "synced", error: null, conflict: null, resolvedAt: new Date(), resolvedById: userId, updatedAt: new Date() }).where(eq(accountingLinks.id, link.id));
    }
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: inv.id, action: "accounting_conflict_resolved", changes: [{ field: "kept", from: link.status, to: choice }] });
    return this.overview(orgId);
  }

  /* ---------------- demo hooks ---------------- */

  async demoRecords(orgId: string) {
    return new DemoProvider(this.db, orgId).list();
  }

  async demoEdit(orgId: string, remoteId: string, patch: Record<string, unknown>) {
    return new DemoProvider(this.db, orgId).editRemote(remoteId, patch);
  }

  /* ---------------- plumbing ---------------- */

  private async provider(orgId: string, settings: AccountingSettings): Promise<AccountingProvider> {
    const key = settings.provider;
    if (!key) throw new BadRequestException("No accounting provider chosen");
    if (key === "demo") return new DemoProvider(this.db, orgId);
    const conn = await this.integrations.connection(orgId, key);
    if (!conn) throw new BadRequestException(`${key === "xero" ? "Xero" : "QuickBooks"} is not connected`);
    if (!conn.externalId) throw new BadRequestException(`${key === "xero" ? "Xero organisation" : "QuickBooks company"} is missing — reconnect`);
    const token = () => this.integrations.freshToken(orgId, key);
    if (key === "quickbooks") return new QuickBooksProvider(token, conn.externalId, settings.quickbooksItemName || "Services");
    return new XeroProvider(token, conn.externalId, { salesAccountCode: settings.xeroSalesAccountCode || "200", paymentAccountCode: settings.xeroPaymentAccountCode || "090", taxType: process.env.XERO_TAX_TYPE || "OUTPUT" });
  }

  private async loadInvoices(orgId: string, invoiceId?: string) {
    return this.db.query.invoices.findMany({
      where: and(eq(invoices.organizationId, orgId), isNull(invoices.archivedAt), inArray(invoices.status, [...SYNCABLE]), ...(invoiceId ? [eq(invoices.id, invoiceId)] : [])),
      with: {
        company: { columns: { id: true, name: true, email: true } },
        contact: { columns: { id: true, firstName: true, lastName: true, email: true } },
        items: { orderBy: (t, { asc: a }) => [a(t.position)] },
        payments: { orderBy: asc(invoicePayments.paidAt) },
      },
      orderBy: [asc(invoices.issueDate), asc(invoices.createdAt)],
    });
  }

  private async notifyAdmins(orgId: string, label: string, items: { number: string; status: "drifted" | "conflict"; reason: string }[]) {
    const admins = await this.db.query.memberships.findMany({ where: eq(memberships.organizationId, orgId), columns: { userId: true, role: true } });
    const conflicts = items.filter((i) => i.status === "conflict").length;
    const title = items.length === 1 ? `${items[0]!.number} differs from ${label} — decide which to keep` : `${items.length} invoices differ from ${label} — decide which to keep`;
    const body = items.length === 1 ? items[0]!.reason : `${conflicts} edited on both sides, ${items.length - conflicts} edited only in ${label}. Nothing was overwritten.`;
    for (const m of admins.filter((x) => x.role === "owner" || x.role === "admin")) {
      await this.notifications.notifyDirect({ orgId, receiverId: m.userId, entityType: "workspace", entityId: orgId, verb: "accounting_conflict", title, body, data: { link: "/finance/accounting" } }).catch(() => undefined);
    }
  }
}

/* ---------------- pure helpers ---------------- */

function toPayload(inv: LoadedInvoice, customerRemoteId: string): InvoicePayload {
  return {
    number: inv.number,
    title: inv.title,
    customerRemoteId,
    issueDate: isoDay(inv.issueDate),
    dueDate: inv.dueDate ? isoDay(inv.dueDate) : null,
    currency: inv.currency,
    lines: inv.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, amount: i.amount })),
    subtotal: inv.subtotal,
    discountPercent: inv.discountPercent,
    discountAmount: inv.discountAmount,
    taxRate: inv.taxRate,
    taxAmount: inv.taxAmount,
    total: inv.total,
    notes: inv.notes,
    void: inv.status === "void" || inv.status === "superseded",
  };
}

/** What we last pushed, as a fingerprint. Payments are deliberately excluded — they sync as their own records. */
function hashOf(p: InvoicePayload) {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 40);
}
