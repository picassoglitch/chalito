# ADR 0012: Payments provider: Stripe behind `BillingProvider`, Mercado Pago stub

- Status: Proposed (M0). Entity choice is owner decision #23.

## Verified context (2026-10-03)
- Stripe API version `2026-09-30.endive`, `stripe` npm 23.
- Hosted Checkout handles subscriptions and one-time payments. There is a Customer Portal. Webhooks are signed (`Stripe-Signature`, verified on the raw body). Idempotency keys are pruned after 24 h.
- **Trials:** the new Trial Offer API is **not supported in Checkout**. Checkout still uses the "legacy" `subscription_data.trial_end` / `trial_period_days`.
- **Mexico:**
  - A Stripe MX account **settles only in MXN**.
  - **Adaptive Pricing needs the price currency to be a settlement currency**, so USD prices on an MX account get no automatic MXN presentment. This is inferred from two docs; confirm with Stripe. Charging USD from MX works, with a +2% conversion fee.
  - MX fees: cards 3.6% + MXN 3.
  - **OXXO and SPEI can't be used for subscriptions.** Both are fine for one-time MXN payments. MSI with Billing is unverified.
- Stripe recommends **sandboxes** over the legacy test mode for new integrations.

## Decision
- `packages/billing` defines `BillingProvider { createCheckout(sku) ; createSubscription(tier, trialEnd?) ; portalUrl() ; verifyWebhook(raw, headers) ; mapEvent(e) }`. `apps/api/src/billing` depends only on the interface.
- **Stripe** is the beta implementation. A **Mercado Pago** stub implements the same interface (preapproval plans with free trial, Checkout Pro, `x-signature` HMAC). It runs only in the conformance suite.
- **The trial is Chalito-side, not Stripe-side.**
  - `subscriptions/{uid}.trialEndsAt = firstSignIn + P1M`. No card is needed to start.
  - If a user subscribes during the trial, Checkout gets `subscription_data.trial_end = trialEndsAt` so the first charge lands when our trial ends. The Customer Portal is configured with `trial_update_behavior=continue_trial`.
- **Entitlements are granted only from verified webhooks.** The idempotency key is the provider event id. Ledger entry ids are derived from it.
- `scripts/sync-billing-catalog.ts` creates products and prices from `plans.yaml` + `catalog.yaml` in a **Stripe sandbox only**. Live mode needs the owner's go.
- **Currency:** USD is the billing currency, per the brief. Presentment depends on the entity:
  - **US entity** (e.g. Atlas): USD prices + Adaptive Pricing → MXN shown automatically (customer pays a 2–4% FX fee).
  - **MX entity**: USD prices are charged as USD (+2% FX for us). Local MXN prices need owner-set amounts in config (`currency_options`). The brief forbids MXN amounts until the owner sets them. OXXO/SPEI only for one-time buckets and cosmetics in MXN.
  - The code is entity-agnostic; the choice is config + OPS.

## Consequences
- No card data touches our services (hosted Checkout and Portal).
- `currency-literal` lint bans price literals in `apps/**`. The UI renders prices from config.
