import type { AccountingProviderKey } from "../../db/schema.js";

/**
 * Row 131: the slice of an accounting ledger we talk to. Deliberately tiny —
 * customers, invoices, payments — and one-directional (we push, we never
 * pull edits back). `version` is whatever the ledger uses to mark a change
 * (QuickBooks SyncToken, Xero UpdatedDateUTC); the sync engine only ever
 * compares it for equality.
 */
export interface RemoteRef {
  id: string;
  version: string;
  label?: string | null;
}

export interface CustomerPayload {
  name: string;
  email: string | null;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoicePayload {
  number: string;
  title: string;
  customerRemoteId: string;
  /** YYYY-MM-DD */
  issueDate: string;
  dueDate: string | null;
  currency: string;
  lines: InvoiceLine[];
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  void: boolean;
}

export interface PaymentPayload {
  invoiceRemoteId: string;
  customerRemoteId: string;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
  reference: string | null;
  method: string;
}

export interface RemoteInvoice {
  id: string;
  version: string;
  number: string | null;
  total: number | null;
  amountPaid: number | null;
  status: string | null;
  updatedAt: string | null;
}

export interface AccountingProvider {
  readonly key: AccountingProviderKey;
  readonly label: string;
  findCustomer(name: string): Promise<RemoteRef | null>;
  createCustomer(p: CustomerPayload): Promise<RemoteRef>;
  getInvoice(remoteId: string): Promise<RemoteInvoice | null>;
  createInvoice(p: InvoicePayload): Promise<RemoteRef>;
  /** Full replace of the ledger copy with ours. */
  updateInvoice(remoteId: string, p: InvoicePayload): Promise<RemoteRef>;
  voidInvoice(remoteId: string): Promise<RemoteRef>;
  createPayment(p: PaymentPayload): Promise<RemoteRef>;
  /** Deep link to open the record in the ledger's UI, when the provider has one. */
  invoiceUrl(remoteId: string): string | null;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const isoDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export const round2 = (n: number) => Math.round(n * 100) / 100;
