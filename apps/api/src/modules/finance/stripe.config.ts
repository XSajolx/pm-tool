/**
 * Row 129: Stripe is configured entirely from the API .env — no keys are ever
 * stored in the database or shipped to the browser.
 *
 *   STRIPE_SECRET_KEY      sk_live_… / sk_test_…  (required for "Pay now")
 *   STRIPE_WEBHOOK_SECRET  whsec_…                (recommended; without it the
 *                          return page confirms the session by asking Stripe)
 */
export function stripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY?.trim() || null;
}
export function stripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}
export function stripeConfigured() {
  return Boolean(stripeSecretKey());
}

/** Row 116 health card (pure so the integrations page needs no DI on finance). */
export function stripeHealth() {
  const key = stripeSecretKey();
  const mode = key?.startsWith("sk_test_") ? "test" : key?.startsWith("sk_live_") ? "live" : null;
  return {
    id: "payments",
    label: "Card payments (Stripe)",
    status: !key ? "not_set_up" : "connected",
    detail: !key
      ? "Add STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET) to the API .env to show Pay now on invoice links"
      : `${mode === "test" ? "Test mode" : mode === "live" ? "Live mode" : "Configured"}${stripeWebhookSecret() ? " · webhook secret set" : " · no webhook secret: payments are confirmed when the client returns to the invoice page"}`,
    lastCheckedAt: null as string | null,
    lastError: null as string | null,
    canCheck: false,
  };
}
