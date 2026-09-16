import { Body, Controller, Get, Headers, Param, Post, Req, Res, UsePipes, type RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Public } from "../auth/auth.decorators.js";
import { InvoicesService } from "./invoices.service.js";
import { StripeService } from "./stripe.service.js";

const checkoutSchema = z.object({ amount: z.number().positive().nullable().optional() });
const confirmSchema = z.object({ sessionId: z.string().min(4).max(255) });

/**
 * Row 156: what the client opens. No login — the unguessable token in the
 * link is the credential, same trust model as the proposal links.
 * Row 129: the same token starts and confirms a Stripe Checkout.
 */
@Controller("public/invoices")
export class PublicInvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly stripe: StripeService,
  ) {}

  @Public()
  @Get(":token")
  view(@Param("token") token: string) {
    return this.invoices.view(token);
  }

  @Public()
  @Get(":token/pdf")
  async pdf(@Param("token") token: string, @Res() res: Response) {
    const { bytes, filename } = await this.invoices.publicPdf(token);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }

  /** Row 129: returns the hosted Stripe page to send the client to. */
  @Public()
  @Post(":token/checkout")
  @UsePipes(new ZodValidationPipe(checkoutSchema))
  checkout(@Param("token") token: string, @Body() dto: z.infer<typeof checkoutSchema>) {
    return this.stripe.createCheckout(token, dto.amount ?? null);
  }

  /** Row 129: called by the invoice page when Stripe sends the client back. */
  @Public()
  @Post(":token/checkout/confirm")
  @UsePipes(new ZodValidationPipe(confirmSchema))
  confirm(@Param("token") token: string, @Body() dto: z.infer<typeof confirmSchema>) {
    return this.stripe.confirm(token, dto.sessionId);
  }
}

/** Row 129: Stripe → us. Signature-verified against the raw body; no auth header. */
@Controller("public/stripe")
export class StripeWebhookController {
  constructor(private readonly stripe: StripeService) {}

  @Public()
  @Post("webhook")
  webhook(@Req() req: RawBodyRequest<Request>, @Headers("stripe-signature") signature: string | undefined) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    return this.stripe.webhook(raw, signature);
  }
}
