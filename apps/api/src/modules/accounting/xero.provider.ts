import { ProviderError, type AccountingProvider, type CustomerPayload, type InvoicePayload, type PaymentPayload, type RemoteInvoice, type RemoteRef } from "./provider.js";

interface XContact { ContactID: string; Name: string; UpdatedDateUTC?: string }
interface XInvoice { InvoiceID: string; InvoiceNumber?: string; Status?: string; Total?: number; AmountPaid?: number; UpdatedDateUTC?: string }
interface XPayment { PaymentID: string; UpdatedDateUTC?: string }

/**
 * Xero (Accounting API 2.0). ACCREC invoices with exclusive line amounts on
 * one revenue account; payments land in the configured bank account.
 * UpdatedDateUTC is the version marker.
 */
export class XeroProvider implements AccountingProvider {
  readonly key = "xero" as const;
  readonly label = "Xero";

  constructor(
    private readonly token: () => Promise<string>,
    private readonly tenantId: string,
    private readonly opts: { salesAccountCode: string; paymentAccountCode: string; taxType: string },
  ) {}

  invoiceUrl(remoteId: string) {
    return `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(remoteId)}`;
  }

  async findCustomer(name: string) {
    const j = await this.call<{ Contacts?: XContact[] }>("GET", `/Contacts?where=${encodeURIComponent(`Name=="${name.replace(/"/g, '\\"')}"`)}`);
    const c = j.Contacts?.[0];
    return c ? ref(c.ContactID, c.UpdatedDateUTC, c.Name) : null;
  }

  async createCustomer(p: CustomerPayload) {
    const j = await this.call<{ Contacts: XContact[] }>("PUT", "/Contacts", { Contacts: [{ Name: p.name, ...(p.email ? { EmailAddress: p.email } : {}) }] });
    const c = j.Contacts[0]!;
    return ref(c.ContactID, c.UpdatedDateUTC, c.Name);
  }

  async getInvoice(remoteId: string): Promise<RemoteInvoice | null> {
    const j = await this.call<{ Invoices?: XInvoice[] }>("GET", `/Invoices/${encodeURIComponent(remoteId)}`, undefined, true);
    const inv = j?.Invoices?.[0];
    if (!inv) return null;
    return {
      id: inv.InvoiceID,
      version: inv.UpdatedDateUTC ?? "",
      number: inv.InvoiceNumber ?? null,
      total: inv.Total ?? null,
      amountPaid: inv.AmountPaid ?? null,
      status: inv.Status?.toLowerCase() ?? null,
      updatedAt: xeroDate(inv.UpdatedDateUTC),
    };
  }

  async createInvoice(p: InvoicePayload) {
    const j = await this.call<{ Invoices: XInvoice[] }>("PUT", "/Invoices", { Invoices: [this.body(p)] });
    const inv = j.Invoices[0]!;
    return ref(inv.InvoiceID, inv.UpdatedDateUTC, inv.InvoiceNumber);
  }

  async updateInvoice(remoteId: string, p: InvoicePayload) {
    const j = await this.call<{ Invoices: XInvoice[] }>("POST", `/Invoices/${encodeURIComponent(remoteId)}`, { Invoices: [{ ...this.body(p), InvoiceID: remoteId }] });
    const inv = j.Invoices[0]!;
    return ref(inv.InvoiceID, inv.UpdatedDateUTC, inv.InvoiceNumber);
  }

  async voidInvoice(remoteId: string) {
    const j = await this.call<{ Invoices: XInvoice[] }>("POST", `/Invoices/${encodeURIComponent(remoteId)}`, { Invoices: [{ InvoiceID: remoteId, Status: "VOIDED" }] });
    const inv = j.Invoices[0]!;
    return ref(inv.InvoiceID, inv.UpdatedDateUTC, inv.InvoiceNumber);
  }

  async createPayment(p: PaymentPayload) {
    const j = await this.call<{ Payments: XPayment[] }>("PUT", "/Payments", {
      Payments: [{ Invoice: { InvoiceID: p.invoiceRemoteId }, Account: { Code: this.opts.paymentAccountCode }, Date: p.date, Amount: p.amount, ...(p.reference ? { Reference: p.reference.slice(0, 255) } : {}) }],
    });
    const pay = j.Payments[0]!;
    return ref(pay.PaymentID, pay.UpdatedDateUTC, null);
  }

  private body(p: InvoicePayload) {
    return {
      Type: "ACCREC",
      Contact: { ContactID: p.customerRemoteId },
      Date: p.issueDate,
      ...(p.dueDate ? { DueDate: p.dueDate } : {}),
      InvoiceNumber: p.number,
      Reference: p.title.slice(0, 255),
      CurrencyCode: p.currency,
      Status: "AUTHORISED",
      LineAmountTypes: "Exclusive",
      LineItems: p.lines.map((l) => ({
        Description: l.description.slice(0, 4000),
        Quantity: l.quantity,
        UnitAmount: l.unitPrice,
        AccountCode: this.opts.salesAccountCode,
        TaxType: p.taxRate > 0 ? this.opts.taxType : "NONE",
        ...(p.discountPercent > 0 ? { DiscountRate: p.discountPercent } : {}),
      })),
    };
  }

  private async call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, allow404 = false): Promise<T> {
    const res = await fetch(`https://api.xero.com/api.xro/2.0${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, "xero-tenant-id": this.tenantId, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && allow404) return null as T;
    const json = (await res.json().catch(() => ({}))) as { Message?: string; Detail?: string; Elements?: { ValidationErrors?: { Message: string }[] }[] } & T;
    if (!res.ok) {
      const v = json.Elements?.[0]?.ValidationErrors?.map((e) => e.Message).join("; ");
      throw new ProviderError(v || json.Detail || json.Message || `Xero ${res.status}`, res.status);
    }
    return json;
  }
}

/** Xero returns "/Date(1700000000000+0000)/" in JSON. */
function xeroDate(s: string | undefined) {
  if (!s) return null;
  const m = /\/Date\((\d+)/.exec(s);
  return m ? new Date(Number(m[1])).toISOString() : s;
}
const ref = (id: string, version: string | undefined, label: string | null | undefined): RemoteRef => ({ id, version: version ?? "", label: label ?? null });
