import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { webBase } from "../integrations/integrations.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { InvoicesService } from "./invoices.service.js";
import { stripeConfigured, stripeSecretKey, stripeWebhookSecret } from "./stripe.config.js";

/** Currencies Stripe bills in whole units (no ×100). */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const EPS = 0.005;

interface CheckoutSession {
  id: string;
  url: string | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | null;
  metadata?: Record<string, string>;
  customer_details?: { email?: string | null; name?: string | null } | null;
}

/**
 * Row 129: "Pay now" on the client invoice link. Stripe Checkout hosts the
 * card form, so no card data ever touches this API. The invoice is settled
 * from two independent signals — the signed webhook and the return page's
 * confirm call — and `recordPayment` makes the second one a no-op, so the
 * money is counted once whichever arrives first.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(
    private readonly invoices: InvoicesService,
    private readonly notifications: NotificationsService,
  ) {}

  get configured() {
    return stripeConfigured();
  }

  /* ---------------- checkout ---------------- */

  /**
   * Start a Checkout Session for the balance due (or a smaller amount the
   * client chooses). Returns the hosted page URL the browser should go to.
   */
  async createCheckout(token: string, amount?: number | null) {
    if (!this.configured) throw new BadRequestException("Online payments are not set up");
    const inv = await this.invoices.resolveToken(token);
    if (!this.invoices.payOnline(inv)) throw new BadRequestException("This invoice cannot be paid online");
    const pay = amount != null ? round2(amount) : inv.balanceDue;
    if (!(pay > 0)) throw new BadRequestException("Amount must be greater than zero");
    if (pay > inv.balanceDue + EPS) throw new BadRequestException(`That is more than the balance due (${inv.currency} ${inv.balanceDue.toFixed(2)})`);

    const currency = inv.currency.toLowerCase();
    const unitAmount = ZERO_DECIMAL.has(inv.currency.toUpperCase()) ? Math.round(pay) : Math.round(pay * 100);
    const back = `${webBase()}/i/${token}`;
    const partial = pay < inv.balanceDue - EPS;
    const form: Record<string, string> = {
      mode: "payment",
      client_reference_id: inv.id,
      success_url: `${back}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: back,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": currency,
      "line_items[0][price_data][unit_amount]": String(unitAmount),
      "line_items[0][price_data][product_data][name]": `Invoice ${inv.number}${partial ? " (part payment)" : ""}`,
      "line_items[0][price_data][product_data][description]": inv.title.slice(0, 500),
      "metadata[invoiceId]": inv.id,
      "metadata[invoiceNumber]": inv.number,
      "metadata[orgId]": inv.organizationId,
      "payment_intent_data[description]": `Invoice ${inv.number} — ${inv.title}`.slice(0, 1000),
      "payment_intent_data[metadata][invoiceId]": inv.id,
    };
    const email = inv.contact?.email;
    if (email) form.customer_email = email;
    const session = await this.stripe<CheckoutSession>("POST", "/v1/checkout/sessions", form);
    if (!session.url) throw new BadRequestException("Stripe did not return a checkout page");
    return { url: session.url, sessionId: session.id, amount: pay, currency: inv.currency };
  }

  /**
   * The return page calls this with the session id from the success URL. It
   * asks Stripe (never trusts the query string) and settles if paid. Also the
   * only path that works when no webhook is configured (local dev).
   */
  async confirm(token: string, sessionId: string) {
    if (!this.configured) throw new BadRequestException("Online payments are not set up");
    const inv = await this.invoices.resolveToken(token);
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new BadRequestException("Not a checkout session");
    const session = await this.stripe<CheckoutSession>("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (session.metadata?.invoiceId !== inv.id) throw new NotFoundException("That payment is not for this invoice");
    if (session.payment_status !== "paid") return { paid: false as const, status: session.payment_status };
    await this.settle(session);
    return { paid: true as const, amount: fromMinor(session.amount_total ?? 0, session.currency ?? inv.currency) };
  }

  /* ---------------- webhook ---------------- */

  /** Verifies the Stripe-Signature header (t=…,v1=…) against the raw body. */
  verifySignature(raw: Buffer, header: string | undefined, toleranceSec = 300) {
    const secret = stripeWebhookSecret();
    if (!secret) throw new BadRequestException("STRIPE_WEBHOOK_SECRET is not set");
    if (!header) throw new BadRequestException("Missing Stripe-Signature header");
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
    const t = parts.t;
    const v1 = parts.v1;
    if (!t || !v1) throw new BadRequestException("Malformed Stripe-Signature header");
    if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new BadRequestException("Webhook timestamp outside tolerance");
    const expected = createHmac("sha256", secret).update(`${t}.${raw.toString("utf8")}`).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(v1, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException("Webhook signature mismatch");
  }

  async webhook(raw: Buffer, signature: string | undefined) {
    this.verifySignature(raw, signature);
    const event = JSON.parse(raw.toString("utf8")) as { id: string; type: string; data: { object: CheckoutSession } };
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      if (session.payment_status === "paid") await this.settle(session);
    }
    return { received: true };
  }

  /* ---------------- settle ---------------- */

  private async settle(session: CheckoutSession) {
    const invoiceId = session.metadata?.invoiceId ?? session.metadata?.invoice_id;
    if (!invoiceId) {
      this.logger.warn(`Stripe session ${session.id} has no invoiceId metadata`);
      return;
    }
    const ref = session.payment_intent ?? session.id;
    const inv = await this.invoices.findAnyOrg(invoiceId);
    if (!inv) {
      this.logger.warn(`Stripe session ${session.id} references unknown invoice ${invoiceId}`);
      return;
    }
    const amount = fromMinor(session.amount_total ?? 0, session.currency ?? inv.currency);
    const before = inv.amountPaid;
    const after = await this.invoices.recordPayment(inv.organizationId, null, inv.id, {
      amount,
      method: "card",
      paidAt: new Date().toISOString(),
      reference: ref,
      note: `Paid online (Stripe)${session.customer_details?.email ? ` by ${session.customer_details.email}` : ""}`,
      provider: "stripe",
      providerRef: ref,
    });
    if (after.amountPaid > before + EPS && inv.createdById) {
      await this.notifications.notifyDirect({
        orgId: inv.organizationId,
        receiverId: inv.createdById,
        entityType: "invoice",
        entityId: inv.id,
        verb: "invoice_paid",
        title: `${inv.number} paid online — ${inv.currency} ${amount.toFixed(2)}${after.status === "paid" ? " (settled)" : " (part payment)"}`,
        body: inv.title,
        data: { invoiceId: inv.id, amount, provider: "stripe" },
      });
    }
  }

  /* ---------------- transport ---------------- */

  private async stripe<T>(method: "GET" | "POST", path: string, form?: Record<string, string>) {
    const key = stripeSecretKey();
    if (!key) throw new BadRequestException("Online payments are not set up");
    const res = await fetch(`https://api.stripe.com${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), "stripe-version": "2024-06-20" },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; type?: string } };
    if (!res.ok) {
      const msg = json.error?.message ?? `Stripe returned ${res.status}`;
      this.logger.warn(`Stripe ${method} ${path} failed: ${msg}`);
      throw new BadRequestException(res.status === 401 ? "Stripe rejected the API key — check STRIPE_SECRET_KEY" : msg);
    }
    return json as T;
  }
}

function fromMinor(n: number, currency: string) {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? n : round2(n / 100);
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
