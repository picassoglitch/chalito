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
| `stream-usage.ts` | `HubStreamUsage` for voice streams: admit, price an increment (`event`), keep alive, settle. |
| `voice-sessions.ts` | Voice metered on the server (`chalito_private.voice_sessions`, migration `20261004003010`). See below. |

**Hub client details:**
- **admit / usage / settle / balance.** Usage takes at most 100 events per call, each with `cost_usd_micros` and an idempotent `source_id`.
- **Failure handling:** a 4xx other than 408/429 is permanent (`dead`); network errors, 5xx, 408 and 429 are retried.
- **Balance (verified in the hub code):** `GET /usage/balance` returns `{ok: true, balance: TokenBalance}` and is parsed strictly. `TokenBalance` is `{remaining, unlimited, monthlyAllocation, bonus, monthlyUsed, reserved, periodStart}`; `reserved` exists only on the consumption-caps branch, so it defaults to 0. A 404 (`unknown user_id`) throws `HubUnavailable`.
- **`unlimited` users (hub admins)** skip out-of-tokens checks but are still metered.
- **admit / settle** match chalyb `a5733df`, which isn't on chalyb main yet:
  - admit field rules: job id `[A-Za-z0-9_.:-]{1,128}`, operation `^[a-z][a-z0-9_.]{0,63}$`, `ttl_seconds` 60–86400;
  - refusals may carry `detail` and `limits`;
  - **any non-200 admit (including a 404 from a hub without the route) is `HubUnavailable`**, which callers treat as no: free_min, no recharge line;
  - settle reports a 409 (closed reservation) separately, so a stream stops on it.

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

Sent rows are purged after 45 days (monthly caps read the outbox; migration 20261004003020). Dead rows stay until someone resolves them.

The notifier exposes `POST /tasks/drain-usage` (Google OIDC). Point a Cloud Scheduler job at it every minute, with `SCHEDULER_SA_EMAIL` as the signer.

**Caveat:** the hub rejects `occurred_at` older than 7 days. Events stuck longer than that (a week-long hub outage) go `dead`, still alerted and kept.

## Voice sessions (R-H6, R-M8)

Voice is billed from what Chalito observes, never from what a client reports.

**Desktop push-to-talk (`/v1/voice`).** The device talks to OpenAI over WebRTC directly, so the api:
- records the session when it mints the client secret;
- bills the time since then, capped at the session's maximum (30 min, lowered to this month's remaining minutes);
- allows one open session per owner.

**Phone calls (notifier).** The voice leg is admitted on the hub before the call is accepted. It's bounded by Twilio's `<Dial timeLimit>`: the remaining minutes, at most 20 min.

**How billing works:**
- Each increment's usage event is written in the same transaction as `billed_seconds`, with source_id `<session>:<total>`. Retried heartbeats and concurrent ones never double-bill.
- The notifier's drain task (every minute) bills sessions that were never ended in full, and settles their reservations.
- **Limit:** without a server-side handle on the WebRTC call, the api can't hang up a desktop session that ignores `continue: false`. It stops billing at the session's maximum. Proxying the SDP exchange through the api would give it that handle; that needs a desktop change.

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

## Monthly plan caps

`caps.ts` reads the plan's monthly WhatsApp, calls, SMS and voice-minute inclusions from `plans.yaml`, through the entitlements function. They're counted per calendar month in the user's time zone (`localMonthStart`).

- **Margin first:** an unset limit allows nothing. Chalyb Gratis gets no paid channels.
- **Notifier:** counts `notification_sends`, excluding suppressed (`failed`) rows. The check runs **before** the hub admit. Over the cap, the channel is suppressed with `cap_reached` (push and desktop are unaffected), and the user gets one in-app note per channel per month (`cap_<channel>_<YYYY_MM>`, source `budget`, links to `/creditos`).
- **Voice minutes:** desktop push-to-talk and call voice share them, counted from the outbox's `voice.seconds` events.
  - At the cap, the API refuses new sessions (`voice_cap_reached`) and stops running ones.
  - At the cap, pressing 1 on a call says "open your app" instead of connecting.

## Environment

| Variable | Where |
|---|---|
| `CHALYB_BASE_URL` | api, notifier. Must be `https://www.chalyb.com`. |
| `CHALITO_ADMIN_TOKEN` | api, notifier. Engine bearer, from Secret Manager. |
| `SCHEDULER_SA_EMAIL` | notifier. Cloud Scheduler's OIDC signer for the drain. |
| `OWNER_UIDS` | Comped owner accounts, comma-separated. |
