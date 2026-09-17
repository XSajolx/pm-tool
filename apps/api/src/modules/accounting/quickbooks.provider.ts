import { quickbooksApiBase } from "../integrations/integrations.service.js";
import { ProviderError, type AccountingProvider, type CustomerPayload, type InvoicePayload, type PaymentPayload, type RemoteInvoice, type RemoteRef } from "./provider.js";

interface QboMeta { LastUpdatedTime?: string }
interface QboCustomer { Id: string; SyncToken: string; DisplayName: string; MetaData?: QboMeta }
interface QboItem { Id: string; Name: string }
interface QboAccount { Id: string; Name: string }
interface QboInvoice { Id: string; SyncToken: string; DocNumber?: string; TotalAmt?: number; Balance?: number; MetaData?: QboMeta }
interface QboPayment { Id: string; SyncToken: string }

/**
 * QuickBooks Online (Accounting API v3). Every invoice line is a
 * SalesItemLineDetail on one service Item; discount is a DiscountLineDetail;
 * tax goes through TxnTaxDetail with the TAX / NON tax codes. SyncToken is the
 * version marker — QuickBooks itself refuses a stale one, which is a second
 * safety net under the engine's own conflict check.
 */
export class QuickBooksProvider implements AccountingProvider {
  readonly key = "quickbooks" as const;
  readonly label = "QuickBooks Online";
  private itemId: string | null = null;

  constructor(
    private readonly token: () => Promise<string>,
    private readonly realmId: string,
    private readonly itemName: string,
  ) {}

  invoiceUrl(remoteId: string) {
    const host = quickbooksApiBase().includes("sandbox") ? "https://app.sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com";
    return `${host}/app/invoice?txnId=${encodeURIComponent(remoteId)}`;
  }

  async findCustomer(name: string) {
    const rows = await this.query<QboCustomer>("Customer", `select * from Customer where DisplayName = '${esc(name)}'`);
    const c = rows[0];
    return c ? ref(c.Id, c.SyncToken, c.DisplayName) : null;
  }

  async createCustomer(p: CustomerPayload) {
    const j = await this.call<{ Customer: QboCustomer }>("POST", "/customer", { DisplayName: p.name, ...(p.email ? { PrimaryEmailAddr: { Address: p.email } } : {}) });
    return ref(j.Customer.Id, j.Customer.SyncToken, j.Customer.DisplayName);
  }

  async getInvoice(remoteId: string): Promise<RemoteInvoice | null> {
    const j = await this.call<{ Invoice: QboInvoice }>("GET", `/invoice/${encodeURIComponent(remoteId)}`, undefined, true);
    if (!j) return null;
    const inv = j.Invoice;
    const total = inv.TotalAmt ?? null;
    const balance = inv.Balance ?? null;
    return {
      id: inv.Id,
      version: inv.SyncToken,
      number: inv.DocNumber ?? null,
      total,
      amountPaid: total != null && balance != null ? total - balance : null,
      status: balance === 0 ? "paid" : balance != null && total != null && balance < total ? "partially_paid" : "open",
      updatedAt: inv.MetaData?.LastUpdatedTime ?? null,
    };
  }

  async createInvoice(p: InvoicePayload) {
    const j = await this.call<{ Invoice: QboInvoice }>("POST", "/invoice", await this.body(p));
    return ref(j.Invoice.Id, j.Invoice.SyncToken, j.Invoice.DocNumber);
  }

  async updateInvoice(remoteId: string, p: InvoicePayload) {
    const cur = await this.call<{ Invoice: QboInvoice }>("GET", `/invoice/${encodeURIComponent(remoteId)}`);
    const j = await this.call<{ Invoice: QboInvoice }>("POST", "/invoice", { ...(await this.body(p)), Id: remoteId, SyncToken: cur.Invoice.SyncToken, sparse: false });
    return ref(j.Invoice.Id, j.Invoice.SyncToken, j.Invoice.DocNumber);
  }

  async voidInvoice(remoteId: string) {
    const cur = await this.call<{ Invoice: QboInvoice }>("GET", `/invoice/${encodeURIComponent(remoteId)}`);
    const j = await this.call<{ Invoice: QboInvoice }>("POST", "/invoice?operation=void", { Id: remoteId, SyncToken: cur.Invoice.SyncToken });
    return ref(j.Invoice.Id, j.Invoice.SyncToken, j.Invoice.DocNumber);
  }

  async createPayment(p: PaymentPayload) {
    const j = await this.call<{ Payment: QboPayment }>("POST", "/payment", {
      CustomerRef: { value: p.customerRemoteId },
      TotalAmt: p.amount,
      TxnDate: p.date,
      ...(p.reference ? { PaymentRefNum: p.reference.slice(0, 21) } : {}),
      Line: [{ Amount: p.amount, LinkedTxn: [{ TxnId: p.invoiceRemoteId, TxnType: "Invoice" }] }],
    });
    return ref(j.Payment.Id, j.Payment.SyncToken, null);
  }

  /* ---------------- shape ---------------- */

  private async body(p: InvoicePayload) {
    const item = await this.ensureItem();
    const taxed = p.taxRate > 0;
    const Line: Record<string, unknown>[] = p.lines.map((l, i) => ({
      LineNum: i + 1,
      Amount: l.amount,
      Description: l.description.slice(0, 4000),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: { ItemRef: { value: item }, Qty: l.quantity, UnitPrice: l.unitPrice, TaxCodeRef: { value: taxed ? "TAX" : "NON" } },
    }));
    if (p.discountPercent > 0) {
      Line.push({ Amount: p.discountAmount, DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: true, DiscountPercent: p.discountPercent } });
    }
    return {
      DocNumber: p.number.slice(0, 21),
      CustomerRef: { value: p.customerRemoteId },
      TxnDate: p.issueDate,
      ...(p.dueDate ? { DueDate: p.dueDate } : {}),
      CurrencyRef: { value: p.currency },
      PrivateNote: p.title.slice(0, 4000),
      ...(p.notes ? { CustomerMemo: { value: p.notes.slice(0, 1000) } } : {}),
      ...(taxed ? { TxnTaxDetail: { TotalTax: p.taxAmount } } : {}),
      Line,
    };
  }

  /** One service Item carries every line; created on first use under the first income account. */
  private async ensureItem() {
    if (this.itemId) return this.itemId;
    const found = await this.query<QboItem>("Item", `select * from Item where Name = '${esc(this.itemName)}'`);
    if (found[0]) return (this.itemId = found[0].Id);
    const accounts = await this.query<QboAccount>("Account", "select * from Account where AccountType = 'Income' maxresults 1");
    if (!accounts[0]) throw new ProviderError("QuickBooks has no income account to file services under");
    const j = await this.call<{ Item: QboItem }>("POST", "/item", { Name: this.itemName, Type: "Service", IncomeAccountRef: { value: accounts[0].Id } });
    return (this.itemId = j.Item.Id);
  }

  /* ---------------- transport ---------------- */

  private async query<T>(entity: string, q: string) {
    const j = await this.call<{ QueryResponse: Record<string, T[]> }>("GET", `/query?query=${encodeURIComponent(q)}`);
    return j.QueryResponse[entity] ?? [];
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, allow404 = false): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${quickbooksApiBase()}/v3/company/${this.realmId}${path}${sep}minorversion=70`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && allow404) return null as T;
    const json = (await res.json().catch(() => ({}))) as { Fault?: { Error?: { Message?: string; Detail?: string }[] } } & T;
    if (!res.ok) {
      const e = json.Fault?.Error?.[0];
      if (res.status === 400 && allow404 && /Object Not Found/i.test(e?.Message ?? "")) return null as T;
      throw new ProviderError(e ? `${e.Message}${e.Detail ? ` — ${e.Detail}` : ""}` : `QuickBooks ${res.status}`, res.status);
    }
    return json;
  }
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const ref = (id: string, version: string, label: string | null | undefined): RemoteRef => ({ id, version, label: label ?? null });
