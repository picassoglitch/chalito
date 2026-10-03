# ADR 0013: Entitlements, metering and the out-of-energy flow

- Status: Accepted (revised after ADR 0016)

## Decision
- **Entitlements = f(hub tier or Solo tier, hub trial, hub balance, comped, now).**
  - This pure function lives in `packages/billing/entitlements.ts`.
  - `EntitlementInputs` is `.strict()` with **no inventory field**, so cosmetics can't affect it. A property test asserts equal output for users who differ only in inventory.
  - Mapping comes from `plans.yaml`: hub `gratis` → none (BYO + `free_min`), `pro` → `standard` access, `vip` → `plus` access. Solo tiers use their own row; bundles use their `mirrors` row.
  - Progressive limits come from `inclusions`. `maxProfile` caps which models a tier can reach. A user may pick a cheaper profile, never a pricier one.
- **The hub is the ledger.** Chalito keeps no credit balance or ledger. The flow is:
  1. **admit** before managed work with `est_tokens`;
  2. `allowed:false` → no work, and the companion explains in character;
  3. report each cost as a `HubUsageEvent` through a Firestore **outbox** (same transaction as the work; drained with backoff; a non-retriable 4xx is marked dead and alerted);
  4. **settle** the reservation.
- **Cost guard by construction:** the hub bills `cost × (1 + margin)`, so every unit earns 160% over cost by default. Allowances follow the hub sizing rule: a fully spent month ≤ the plan's list price. `PlansConfig` rejects an allowance that breaks it.
- **Never billed:** BYO usage, and Claude Code/Codex sessions. Local `usage_events` in BigQuery still record them for the token KPI and the comms-overhead ratio.
- **Out of energy:** when admit returns `no_tokens` (or balance = 0) mid-conversation:
  - the current turn finishes on `free_min`;
  - the companion plays "tired" and says a line from `copy/recharge.*.yaml`;
  - an inline "¿Por qué?" chip opens `/creditos`, which shows the hub balance and links to the hub's plans and packs. **No modal.**
- **Safety features** never depend on plan state or hub availability: sign-in, approvals, revocation, Developer-mode off, export.
- **Comped owner accounts:** the hub already treats admins as never refused. `OWNER_UIDS` in Chalito mirrors that for local checks.
