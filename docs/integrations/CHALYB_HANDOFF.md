# Chalyb hand-off

How a person moves between the Chalyb hub and Chalito, and what each side owns (brief §5 M15, ADR 0016, D-025). This document describes what the code does today on branch `all`. Where the brief asked for something different, the gap is flagged. There's no Chalyb code here; the hub-side work is listed in §6 and in `docs/integrations/CHALYB_ENGINE.md`.

## 1. Status: off, and the one switch

**The brief:** a hand-off interface "with a verifier flag that ships off" (§0.11).

**Decision (coordinator, 2026-10-04):** no new flag. The hub's engine row is the only switch:
- it ships `coming_soon` and stays that way until the owner flips it to `active` (CHALYB_ENGINE.md §2, §9);
- the owner made Chalito a Chalyb engine with the hub link (decision #18, D-025, ADR 0016), so the api routes are always mounted;
- what keeps the integration dark is the hub, not a Chalito setting.

**What "off" (`coming_soon`) means on each surface:**

| Surface | While the row is `coming_soon` |
|---|---|
| Hub catalog and launch | The hub doesn't offer Chalito, and `/auth/launch/chalito` doesn't mint launch tokens for regular users. No one arrives at `chalito.chalyb.com/auth/sso` with a token. |
| `POST /sso/exchange` (api) | Mounted. Without a hub-signed token (`CHALITO_SSO_SECRET`) it answers 401, and replays answer 409. Nothing is created. |
| `POST /tenants`, `/tenants/:id/status` (api) | Mounted. The hub doesn't call them, and anything else gets 401 without the engine bearer (`CHALITO_ADMIN_TOKEN`). |
| Web (`chalito.chalyb.com`) | Loads. Signed out, a visitor is sent to the hub's launch route, which doesn't serve Chalito yet. With `NEXT_PUBLIC_HUB_URL` unset, every hub link is hidden (`apps/web/src/lib/hub.ts`). |
| Usage and billing | No tenants means no admits, no usage events and no settles. The outbox stays empty. |
| Desktop app | Its SSO uses the same hub launch, so sign-in isn't possible. Approvals and other local safety features don't depend on the hub. |
| Safety | Never depends on the switch: approvals, revocation and turning Developer mode off work the same either way. |

**What turns it on:**
1. The owner flips the row to `active` on the hub.
2. The two shared secrets exist: `CHALITO_SSO_SECRET` and `CHALITO_ADMIN_TOKEN` (docs/OPS.md §1, §5).

## 2. Hub → Chalito: launch and SSO

1. The person opens Chalito from the hub. The hub's `/auth/launch/chalito` redirects to:

   `https://chalito.chalyb.com/auth/sso?token=<b64url(JSON payload)>.<b64url(HMAC-SHA256)>`
2. The web page (`apps/web/src/app/[locale]/auth/sso/page.tsx`, `no-referrer`, not indexed) forwards the token to the api's `POST /sso/exchange`.
3. The api (`apps/api/src/hub/sso.ts`, `apps/api/src/routes/hub.ts`):
   - verifies the HMAC with `CHALITO_SSO_SECRET` (constant-time compare);
   - parses the payload strictly (`HubSsoPayload`);
   - rejects it if `exp` (seconds) has passed;
   - burns the token: the signature's hash goes into `chalito_private.sso_tokens`, so a replay gets `409 token_replayed`;
   - upserts the tenant and user (`users.tier` = the payload's `tier`);
   - returns `{customToken, owner}`, where `customToken` is a Supabase magic-link token hash for the hub user (`apps/api/src/supabase/identity.ts`);
   - audits `sso.exchange`.
4. The web opens the Supabase session.

**Token format (reality):**

| Field | Type | Notes |
|---|---|---|
| `user_id` | string | Hub user id; Chalito's `owner` everywhere |
| `email` | email | |
| `tenant_id` | string | |
| `tier` | string | Hub tier id (`free`, `pro`, `vip`); see §4 |
| `exp` | int, seconds | ADR 0016: a 300 s TTL. The api checks expiry only, not the TTL length |

**Brief mismatch:** the brief says "signed hand-off token format (**Ed25519**, short TTL)". The hub's engine contract signs with **HMAC-SHA256** and a shared secret, and Chalito follows the contract. The consequence, recorded in ADR 0016:
- the hub can mint a session for any user in Chalito's cloud;
- it still can't approve on devices, add approvers or turn on Developer mode, because those need the person's passkey or device keys (THREAT_MODEL §4.14).

Moving to Ed25519 would be a hub contract change, so it's listed as optional in §6.

**Post-SSO destination:** the hub's launch route ignores `next` (CHALYB_ENGINE.md §8). Chalito works around it: before sending a signed-out person to the hub, it stores the destination in a 10-minute first-party cookie, `chalito_next`. It validates that cookie again on return (`apps/web/src/lib/next-cookie.ts`, `safeNextPath`: same-origin relative paths only, never `/api`, `/_next` or the SSO page).

**Desktop:** the desktop app runs the same flow in the system browser.
- It opens the SSO start URL with `client=desktop&state=…&redirect_uri=chalito://auth/sso`.
- It accepts only that exact callback with the pending state (single use, 10 minutes).
- It exchanges the token at the same api route (`apps/desktop/src/lib/sso.ts`).
- The web bridge that hands the token to the app (`/auth/desktop`, `apps/web/src/lib/desktop-sso.ts`) is on `origin/m10` and not yet on `all`.

## 3. Chalito → hub: link-outs

| From | Link | Code |
|---|---|---|
| Signed out / session expired | `${NEXT_PUBLIC_HUB_URL}/auth/launch/chalito` | `apps/web/src/lib/hub.ts` |
| Onboarding, Settings ("Planes") | `${NEXT_PUBLIC_HUB_URL}` | `apps/web/src/components/Onboarding.tsx`, `Settings.tsx` |
| `/creditos`, out-of-energy chip | Chalito's own `/creditos` page, meant to show the balance and link on to the hub's plans and packs. On `all` it's still a stub with no hub link | `apps/web/src/app/[locale]/creditos/page.tsx`, `packages/billing/README.md` |

`NEXT_PUBLIC_HUB_URL` must be `https://www.chalyb.com` (the apex drops auth).

**Brief mismatch, `ref`:** the brief wants link-out URLs with a `ref`. **No link carries one today.**

**Proposed:**
- Every Chalito → hub link adds `ref=chalito` plus the surface, for example `ref=chalito.onboarding`, `ref=chalito.creditos`, `ref=chalito.out_of_energy`.
- The hub records it for attribution and otherwise ignores it.
- It must never carry user ids or anything sensitive.

This is open (§7).

## 4. Entitlement mapping

The hub is the source of truth for tier, trial and balance (ADR 0013/0016). Chalito computes entitlements from them with a pure function (`packages/billing/src/entitlements.ts`), reading `packages/config/plans.yaml`.

| Hub state | Chalito access row | Managed allowance |
|---|---|---|
| `free` (Gratis) | none: BYO keys + `free_min` | free_min |
| `pro` | `standard` | the hub balance |
| `vip` | `plus` | the hub balance |
| Trial active | `trial.mirrors` = `starter` | free_min (`trial.managedAllowance`) |
| Solo tier (`lite`, `starter`, `standard`, `plus`, `heavy`) | that tier's own row | the hub balance |
| Bundle `bundle_8` / `bundle_40` | the mirrored tier's row: `lite` / `standard` (decision #2) | the hub balance |
| `OWNER_UIDS` (comped) | top tier (`heavy`), never refused | balance as reported |
| Balance ≤ 0 | the access row stays | free_min (in-character out-of-energy) |

**Rules:**
- An unknown tier string maps to none, so access fails closed.
- Unset values (`mirror_matching_tier`) also fail closed.
- `safetyFeatures` is always true.
- Inventory and cosmetics are not inputs (pay-to-dress).

**Gaps:**
- **Trial.** The hub doesn't expose trial state on balance or admit, so `hubTrialActive` is `false` everywhere (`apps/orchestrator/README.md`, "Not yet").
- **Solo and bundles.** The SSO `tier` is mapped only through `hubTierOf` (`free`, `pro`, `vip`; `packages/billing/src/caps.ts`), so `soloTier` is never set from the hub today. How the hub reports a Solo or bundle purchase isn't defined yet (§6).
- **MXN amounts.** Solo checkout shows "Disponible pronto" until the owner sets MXN amounts on the hub (D-031).

## 5. Provisioning and status

- `POST {admin_api_base}/tenants`, with `Bearer CHALITO_ADMIN_TOKEN` and body `{external_user_id, email, display_name?, tier}`, returns `201 {tenant_id, api_token}`.
  - A duplicate returns `409` with the same body, and the hub treats that as success.
  - `api_token` is derived (HMAC of the tenant id), so nothing secret is stored.
- `POST /tenants/{id}/status {active|paused}` returns `204`.
  - Paused stops managed features only.
  - Sign-in, approvals, revocation, Developer-mode off and export never pause.
- `admin_api_base` = `https://api.chalito.chalyb.com`; `external_url` = `https://chalito.chalyb.com`.

## 6. What Chalyb must implement

These go in the Chalyb repo, on its own PR, with the owner's go. Items 1–5 match CHALYB_ENGINE.md, and the OPS checklist is `docs/OPS.md` §1.

1. Engine definition, migration (`coming_soon`), tfvars entry with the domain override, and the two shared secrets.
2. Launch tokens as in §2: HMAC-SHA256 over the base64url payload, a 300 s TTL, the `tier` field set to the hub tier id.
3. Tenant provisioning and status calls as in §5.
4. The consumption contract:
   - `/usage/admit`, `/usage`, `/usage/settle` and `/usage/balance` on hub `main`, with `reserved` in the balance;
   - the Chalito meter kinds;
   - `store.purchase` billed as already a price (D-030).
5. Report **trial state** (on balance or admit), and define how a **Solo tier or bundle** reaches Chalito: a tier id in the SSO payload and tenant calls, or a field on balance.
6. Optional:
   - forward a validated `next` through `/auth/launch/chalito`;
   - accept and record `ref` on hub pages;
   - an Ed25519 launch token, if the brief's format is wanted (a contract change for every engine).

## 7. Open questions for the owner

- **`ref` values:** confirm the scheme in §3 and whether the hub records it.
- **Solo reporting:** which field carries a Solo or bundle tier (item 5 above)?
- **Token signing:** stay on HMAC (the hub's contract) or ask the hub for Ed25519 (the brief)?
