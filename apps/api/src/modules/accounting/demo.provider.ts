import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { DB } from "../../db/index.js";
import { accountingDemoRecords } from "../../db/schema.js";
import { ProviderError, type AccountingProvider, type CustomerPayload, type InvoicePayload, type PaymentPayload, type RemoteInvoice, type RemoteRef } from "./provider.js";

/**
 * The demo ledger: a Postgres-backed stand-in with the same shape as a real
 * provider, so the whole sync loop — create, update, drift, conflict,
 * resolution — can be exercised without QuickBooks / Xero credentials.
 * `editRemote()` is the "bookkeeper changed it over there" button.
 */
export class DemoProvider implements AccountingProvider {
  readonly key = "demo" as const;
  readonly label = "Demo ledger";

  constructor(
    private readonly db: DB,
    private readonly orgId: string,
  ) {}

  invoiceUrl() {
    return null;
  }

  async findCustomer(name: string) {
    const row = await this.db.query.accountingDemoRecords.findFirst({
      where: and(eq(accountingDemoRecords.organizationId, this.orgId), eq(accountingDemoRecords.kind, "customer"), sql`${accountingDemoRecords.data}->>'name' = ${name}`),
    });
    return row ? this.ref(row) : null;
  }

  async createCustomer(p: CustomerPayload) {
    return this.insert("customer", "cust", { name: p.name, email: p.email });
  }

  async getInvoice(remoteId: string): Promise<RemoteInvoice | null> {
    const row = await this.get(remoteId);
    if (!row || row.kind !== "invoice") return null;
    const d = row.data as { number?: string; total?: number; amountPaid?: number; void?: boolean };
    return {
      id: row.remoteId,
      version: String(row.version),
      number: d.number ?? null,
      total: d.total ?? null,
      amountPaid: d.amountPaid ?? 0,
      status: d.void ? "void" : (d.amountPaid ?? 0) >= (d.total ?? 0) ? "paid" : "open",
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async createInvoice(p: InvoicePayload) {
    return this.insert("invoice", "inv", { ...p, amountPaid: 0 });
  }

  async updateInvoice(remoteId: string, p: InvoicePayload) {
    const row = await this.get(remoteId);
    if (!row) throw new ProviderError("Invoice no longer exists in the demo ledger", 404);
    const amountPaid = (row.data as { amountPaid?: number }).amountPaid ?? 0;
    const [u] = await this.db
      .update(accountingDemoRecords)
      .set({ data: { ...p, amountPaid }, version: row.version + 1, updatedAt: new Date() })
      .where(eq(accountingDemoRecords.id, row.id))
      .returning();
    return this.ref(u!);
  }

  async voidInvoice(remoteId: string) {
    const row = await this.get(remoteId);
    if (!row) throw new ProviderError("Invoice no longer exists in the demo ledger", 404);
    const [u] = await this.db
      .update(accountingDemoRecords)
      .set({ data: { ...row.data, void: true }, version: row.version + 1, updatedAt: new Date() })
      .where(eq(accountingDemoRecords.id, row.id))
      .returning();
    return this.ref(u!);
  }

  async createPayment(p: PaymentPayload) {
    const inv = await this.get(p.invoiceRemoteId);
    if (!inv) throw new ProviderError("Invoice no longer exists in the demo ledger", 404);
    const pay = await this.insert("payment", "pay", { ...p });
    // Applying a payment bumps the invoice like a real ledger would — but that is not a human edit, so version stays.
    await this.db
      .update(accountingDemoRecords)
      .set({ data: { ...inv.data, amountPaid: Math.round((((inv.data as { amountPaid?: number }).amountPaid ?? 0) + p.amount) * 100) / 100 } })
      .where(eq(accountingDemoRecords.id, inv.id));
    return pay;
  }

  /** Test hook: pretend the bookkeeper edited the record in the ledger (version bumps, data patched). */
  async editRemote(remoteId: string, patch: Record<string, unknown>) {
    const row = await this.get(remoteId);
    if (!row) throw new ProviderError("No such record in the demo ledger", 404);
    const [u] = await this.db
      .update(accountingDemoRecords)
      .set({ data: { ...row.data, ...patch }, version: row.version + 1, updatedAt: new Date() })
      .where(eq(accountingDemoRecords.id, row.id))
      .returning();
    return this.ref(u!);
  }

  async list() {
    const rows = await this.db.query.accountingDemoRecords.findMany({ where: eq(accountingDemoRecords.organizationId, this.orgId), orderBy: (t, { desc }) => [desc(t.updatedAt)], limit: 200 });
    return rows.map((r) => ({ remoteId: r.remoteId, kind: r.kind, version: r.version, updatedAt: r.updatedAt.toISOString(), data: r.data }));
  }

  private async get(remoteId: string) {
    return this.db.query.accountingDemoRecords.findFirst({ where: and(eq(accountingDemoRecords.organizationId, this.orgId), eq(accountingDemoRecords.remoteId, remoteId)) });
  }

  private async insert(kind: string, prefix: string, data: Record<string, unknown>) {
    const [row] = await this.db
      .insert(accountingDemoRecords)
      .values({ organizationId: this.orgId, kind, remoteId: `${prefix}_${randomBytes(4).toString("hex")}`, data, version: 1 })
      .returning();
    return this.ref(row!);
  }

  private ref(r: typeof accountingDemoRecords.$inferSelect): RemoteRef {
    const d = r.data as { name?: string; number?: string };
    return { id: r.remoteId, version: String(r.version), label: d.number ?? d.name ?? null };
  }
}
