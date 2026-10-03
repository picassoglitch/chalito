# ADR 0012: Payments: the Chalyb hub (Mercado Pago). No Stripe.

- Status: Accepted (owner, 2026-10-03: "we will use the already implemented Mercado Pago payment system", "no stripe", "same as Chalyb Clip")
- Supersedes: the M0 draft (Stripe behind `BillingProvider`, Mercado Pago stub)

## Decision
- **Chalito takes no payments and holds no payment secrets.** All checkout, subscriptions, trials, renewals, grace periods, token packs, receipts, IVA and CFDI live in the **Chalyb hub**, which already runs Mercado Pago (preapprovals, webhooks, price gate). See ADR 0016.
- Chalito learns plan state from the hub:
  - the `tier` claim in the SSO launch token, refreshed on each launch;
  - `POST /tenants/{id}/status` (active/paused);
  - `GET /api/engines/chalito/usage/balance`;
  - every `/usage/admit` response.
- **Solo Chalito** (the brief's USD ladder) is sold through the same hub checkout.
  - Mercado Pago Mexico charges **MXN**, so each Solo tier needs an owner-set MXN amount in the hub's pricing config. Hub prices exclude IVA.
  - Until those amounts exist, the Solo plans section renders "Disponible pronto" and links to the hub tiers (decision #31).
- **Token buckets** ("credit buckets" in the brief) are the hub's token packs. Solo buckets at ladder price points become hub packs when the owner adds them.
- **Cosmetics** are bought from the hub balance with a priced `store.purchase` event (needs a hub change, D-030). Inventory is granted only after the hub accepts the event (idempotent `source_id`).

## Why
- One payment system, already hardened against MP's retry and webhook gaps (Chalyb's 7-day renewal grace, no first-charge grace), and one customer account across all Chalyb engines.
- No second PCI, CFDI or IVA surface.

## What Chalito still verifies
- The SSO token (HMAC-SHA256, TTL, relative `next`).
- The admin bearer on `/tenants*`.
- Nothing else: no payment webhooks reach Chalito.
