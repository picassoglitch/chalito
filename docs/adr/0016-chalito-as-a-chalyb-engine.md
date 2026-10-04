# ADR 0016: Chalito is a Chalyb engine

- Status: Accepted (owner, 2026-10-03: "this will be a chalyb engine", "same as Chalyb Clip"; backend in Chalyb's GCP project)
- Supersedes: the brief's "Chalyb hand-off interface only" (§0.11), Stripe billing (§5 M12), the Chalito-side trial, and Identity Platform as the account system

## Context
Chalyb is a hub (Next.js on Vercel + Supabase + Mercado Pago) with engines: ChalyClip, ChalyOBS and ChalyCrypto, each in its own repo and deployed to Chalyb's GCP project. The hub owns accounts, plans (Gratis/Pro/VIP, MXN), the trial, token packs and a single **billable-token balance**. Engines integrate through a fixed contract. I read it read-only from Chalyb at `4ed57c9`; it lives in `docs/engines/consumption-contract.md`, `docs/infra/adding-an-engine.md` and `src/lib/engines/integrations/factory.ts`.

## Decision
Chalito stays **its own repo** (`picassoglitch/chalito`) and integrates as engine slug **`chalito`**, exactly like ChalyClip.

1. **Accounts and SSO.** *(Superseded by [ADR 0017](0017-data-layer-supabase.md) for accounts/identity storage: Supabase Auth on the hub project, not Firebase.)*
   - The hub launches users to `https://chalito.chalyb.com/auth/sso?token=<b64url(payload)>.<HMAC-SHA256>&next=<relative>`.
     - The payload is `{user_id, email, tenant_id, tier, exp}` with a 300 s TTL, signed with `CHALITO_SSO_SECRET`.
     - Chalito verifies it, rejects absolute or off-origin `next` (open redirect), and opens its session.
   - The web app then mints a **Firebase custom token** (`uid = hub user_id`) so the PWA and agents can use Firestore listeners and rules. Firebase Auth is used only for custom tokens; Identity Platform sign-in methods are not used.
   - **Second factor:** the hub session plus a **WebAuthn passkey enrolled in Chalito**. It is required for pairing, endorsement, recovery and HIGH approvals, and the device verifies it (D-019). This replaces "Identity Platform 2FA required" (D-027).
2. **Provisioning.**
   - `POST {admin_api_base}/tenants` with `Bearer CHALITO_ADMIN_TOKEN` and body `{external_user_id, email, display_name, tier}` returns `{tenant_id, api_token}`. A 409 duplicate counts as success.
   - `POST /tenants/{id}/status {active|paused}`. **Paused pauses managed features only. Safety features never pause:** sign-in, approvals, revocation, Developer-mode off, export.
3. **Consumption.**
   - Before any managed spend, Chalito calls `POST /api/engines/chalito/usage/admit`. Spend covers companion turns, Mesa turns, voice sessions, calls, WhatsApp/SMS and avatar jobs.
   - Every cost goes to `POST /usage` with `cost_usd_micros` from `prices.yaml`, including cache reads/writes and retries. It is written to a Firestore **outbox** in the same transaction as the work and drained with backoff; `(engine, source_id)` makes this idempotent. Then `POST /usage/settle`.
   - The hub bills `cost × (1 + margin)` (default margin 160%) at $4 per 1M billable tokens. **This replaces Chalito's own credit ledger, buckets and cost guard.** The margin guarantees cost < price per unit.
   - **BYO usage is never sent as billable spend** (we don't charge BYO). It is logged locally for the token KPI only.
   - Claude Code and Codex sessions never touch the hub balance.
4. **Plans** (owner, 2026-10-03: "Both").
   - Chalyb hub tiers include Chalito: Gratis → BYO + `free_min`, Pro → `standard` access, VIP → `plus` access. Token allowance = the hub balance.
   - **Solo Chalito** keeps the brief's USD ladder (`plans.yaml`), sold through the hub's Mercado Pago checkout. MP Mexico charges MXN, so the owner sets MXN charge amounts per Solo tier on the hub; until then Solo checkout shows "Disponible pronto" (decision #31).
   - Access is **progressive** (decision #1): cheap models, WhatsApp and push from Lite; voice from Starter; calls from Standard; premium models and SMS from Plus. Allowance = price ÷ $4 per 1M, the hub's sizing rule.
5. **Trial:** the hub's trial rules (decision #7). Chalito reads trial state from the tier the hub reports and has no trial clock of its own.
6. **Store (cosmetics):** paid from the hub balance as a priced `store.purchase` event (like the hub's `boost.fee`, "already a price"). That needs a small hub change (D-030). Seed items stay free until then.
7. **Infrastructure:**
   - Chalyb's GCP project, `us-central1`.
   - Chalyb's Terraform gets one `engines` map entry: SA, secrets, Cloud Run `api` service, domain mapping.
   - Chalito-only resources live in `chalito/infra/terraform`, targeting the same project with its own state: a **named Firestore database `chalito`**, Pub/Sub topics, Cloud Tasks queues, KMS keyring, buckets, BigQuery dataset `chalito`, and the extra Cloud Run services (`orchestrator`, `notifier`, `mcp-gateway`, `avatar-jobs`).
   - `web` (Next.js PWA) is on **Vercel** (picassoglitch account, like the hub) at `chalito.chalyb.com`, which is also the engine's `external_url`. `admin_api_base` points at the Cloud Run `api`.
8. **Chalyb-side changes** happen in the Chalyb repo, on its own branch and PR, only with the owner's go at launch time (M2 or M12):
   - definitions entry;
   - `register_chalito_engine` migration (ships `coming_soon`);
   - tfvars entry;
   - `CHALITO_ADMIN_TOKEN` / `CHALITO_SSO_SECRET` in Vercel;
   - the meter kinds Chalito sends (`voice.seconds`, `call.seconds`, `whatsapp.messages`, `sms.segments`, `store.purchase`), which need to be confirmed or added on the hub.

## Consequences
- Removes `BillingProvider`/Stripe/Mercado Pago code from Chalito. M12 shrinks to the hub integration, entitlements and the in-character out-of-energy flow.
- **Trust:** the hub can impersonate any user in Chalito's cloud (it holds the SSO secret). It still **cannot** approve on devices, add approvers or enable Developer mode (G1–G3, THREAT_MODEL §4.14).
- Chalito's uptime for managed features depends on the hub's admit endpoint. If admit is unreachable, managed spend fails closed; safety features and BYO keep working.
