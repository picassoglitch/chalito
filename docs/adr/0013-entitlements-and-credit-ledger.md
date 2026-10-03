# ADR 0013: Entitlements and credit ledger

- Status: Accepted (M0); implemented in M12

## Decision
- **Entitlements = f(subscription tier, trial, credit balance, now).** This pure function lives in `packages/billing/entitlements.ts`. Its input type `EntitlementInputs` is `.strict()` and has **no inventory field**, so cosmetics can't affect it by construction. A property test asserts equal outputs for users who differ only in inventory.
- **Fail closed on the owner's ladder.** Any `mirror_matching_tier` value is treated as unset:
  - managed allowance → `disabled_unset` in prod, and the UI shows "Disponible pronto";
  - count limits (devices, sessions, rooms, members, voice/calls/WhatsApp inclusions) → `"unset"`. These are **not enforced** until the owner sets them. Platform rate limits and daily comms caps (calls 3, WhatsApp 10) still apply (D-009).
  - BYO and `free_min` keep working.
- **Safety features never depend on plan state:** sign-in, approvals inbox, revocation, Developer-mode off, data export (`safetyFeatures: true`).
- **Ledger:** append-only `users/{uid}/creditLedger`, written only by server service accounts.
  - `entryId = hash(type, idemKey)`, where `idemKey` is the provider event id (purchases/refunds) or the usage event id (consume). The write is `create` (fails if it exists), so replays are no-ops.
  - Balance is in `users/{uid}/private/creditBalance`, updated **in the same Firestore transaction** as the ledger entry. The transaction aborts if any unit would go negative.
  - Only `orchestrator` writes `consume`. Only `api` writes `purchase|refund|grant|trial|adjust`.
- **Buckets:** sold at the ladder price points. Each grants its matching tier's managed allowance **once**. Credits never expire (owner decision #8).
- **Cost guard:** for every bucket or month, the cumulative provider cost at `prices.yaml` rates must stay ≤ the amount paid. Consumption is denied beyond that, even if units remain, which protects against price drift. Property-tested.
- **What never consumes managed credits:** BYO usage, and Claude Code/Codex sessions (always BYO, under the user's own auth).
- **Out of energy:** when the balance hits 0 mid-turn, the turn finishes on `free_min` (deterministic by default). The companion plays "tired", says a line from `copy/recharge.*.yaml`, and shows an inline "¿Por qué?" chip → `/creditos`. **No modal.**
