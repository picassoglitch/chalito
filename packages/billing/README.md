# @chalito/billing

Chalito bills through the **Chalyb hub** (ADR 0012/0013/0016, D-016/D-029). The hub owns:

- payments (Mercado Pago);
- the trial;
- the billable-token balance;
- the ledger.

Chalito admits work, reports provider costs and settles. It keeps no payment records.

| Module | What |
|---|---|
| `hub.ts` | `HubClient`, the engine contract. It only accepts `https://www.chalyb.com`, with the `CHALITO_ADMIN_TOKEN` bearer. |
| `cost.ts` | Pure: `prices.yaml` → integer `cost_usd_micros`, rounded up. |
| `billable.ts` | `usageEvent(ctx, …)`. It returns **null** for BYO usage and for Claude Code/Codex sessions, so they never reach the outbox or the hub. |
| `outbox.ts`, `postgres-outbox.ts` | The usage outbox (`chalito_private.usage_outbox`, migration `20261004001500`). |
| `entitlements.ts` | Pure: entitlements from tier, trial, balance and comped. |
| `energy.ts` | `admitManaged` and the in-character out-of-energy result. |
| `stream-usage.ts` | `HubStreamUsage` for voice streams. |

**Hub client details:**
- **admit / usage / settle / balance.** Usage takes at most 100 events per call, each with `cost_usd_micros` and an idempotent `source_id`.
- **Failure handling:** a 4xx other than 408/429 is permanent (`dead`); network errors, 5xx, 408 and 429 are retried.
- **Unverified:** the balance response shape isn't in the verified contract notes. The client accepts `{remaining, reserved}` or `{balance: {…}}`.

**Cost rules:**
- Unknown models throw, so we fail closed before spending.
- Unknown WhatsApp/SMS markets use the most expensive known rate.
- Voice charged by wall-clock seconds is priced as both sides talking the whole time (an upper bound).

## Outbox

`enqueueUsage(tx, owner, events)` writes in the **same transaction** as the work it bills. Duplicate `source_id`s are ignored.

`drainOutbox` behaviour:
- claims due rows with `FOR UPDATE SKIP LOCKED` (concurrent drainers never double-send);
- sends up to 100 per call;
- backs off 30 s → 1 h on retriable failures;
- marks rows `dead` and alerts (`billing.usage_dead`) on permanent 4xx. **Nothing is dropped.**

Sent rows are purged after 30 days. Dead rows stay until someone resolves them.

The notifier exposes `POST /tasks/drain-usage` (Google OIDC). Point a Cloud Scheduler job at it every minute, with `SCHEDULER_SA_EMAIL` as the signer.

**Caveat:** the hub rejects `occurred_at` older than 7 days. Events stuck longer than that (a week-long hub outage) go `dead`, still alerted and kept.

## Entitlements

`EntitlementInputs` is `.strict()` with no inventory. A property test asserts identical output for users who differ only in inventory: pay-to-dress, never pay-to-win.

**Access mapping (from `plans.yaml`):**
- hub `free` → none (BYO + free_min);
- `pro` → `standard`;
- `vip` → `plus`;
- Solo tiers use their own row; bundles use their `mirrors` row;
- the trial mirrors `trial.mirrors` on free_min;
- `OWNER_UIDS` (comped) → the top tier, never refused.

Unset (`mirror_matching_tier`) values fail closed: `disabled_unset` / `"unset"`. `safetyFeatures` is always `true`.

## Out of energy

`admitManaged` returns `{ ok: false, outOfEnergy }` when the hub says `no_tokens` or the balance is 0. The turn finishes on `free_min`, with:

- the `tired` animation;
- a line from `packages/config/copy/recharge.{es,en}.yaml`;
- an **inline** "¿Por qué?" chip to `/creditos` (or `/en/creditos`). Never a modal.

Other refusals and an unreachable hub fail closed on free_min without a recharge line. Safety features and BYO never go through it.

## Environment

| Variable | Where |
|---|---|
| `CHALYB_BASE_URL` | api, notifier. Must be `https://www.chalyb.com`. |
| `CHALITO_ADMIN_TOKEN` | api, notifier. Engine bearer, from Secret Manager. |
| `SCHEDULER_SA_EMAIL` | notifier. Cloud Scheduler's OIDC signer for the drain. |
| `OWNER_UIDS` | Comped owner accounts, comma-separated. |
