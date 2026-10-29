# OPS: owner tasks

Everything here needs the owner: an account, a payment, a submission to a third party, or a go for a run that costs money or is externally visible (brief §11). Nothing listed here has been done by code, and no item is claimed as done unless its box is ticked.

**Sources:** collected from `docs/PLAN.md` (Owner decisions), `DEVIATIONS.md`, the ADRs, `docs/integrations/*`, `docs/VERIFIED_APIS.md` and the app/package READMEs. Paths are as on branch `all` unless another branch is named. Collected 2026-10-04.

**Status key:** `[ ]` open, `[x]` done (with date and who), `[~]` decided but not yet applied, `N/A` no longer applies (with the reason).

## 1. Chalyb hub PR (Chalyb repo, owner's go)

The details are in `docs/integrations/CHALYB_ENGINE.md`. These changes go in `picassoglitch/chalyb`, on their own branch and PR (D-025, ADR 0016).

| | What | Why / blocks | Reference |
|---|---|---|---|
| [ ] | Engine definition `chalito` in `src/lib/engines/integrations/definitions.ts` | SSO and launch from the hub (M2) | `docs/integrations/CHALYB_ENGINE.md` §1 |
| [x] | `register_chalito_engine` migration. Verified 2026-10-16: the hub's `public.engines` row `chalito` is `status='active'`, `tier_required='PRO'`, `integration_mode=external_sso_redirect` (Pro and VIP only, owner decision #53) | Engine row on the hub | CHALYB_ENGINE.md §2 |
| [x] | tfvars `engines` entry (2026-10-15, verified). No domain override: Chalito lives inside the hub at `www.chalyb.com/app/chalito`, and the api keeps its run.app URL as `admin_api_base` (owner, 2026-10-05; Chalyb migration 0067) | Infra (M2) | CHALYB_ENGINE.md §3, ADR 0015, `docs/GO_LIVE.md` "Where Chalito lives" |
| [ ] | Secrets `chalito-sso-secret`, `chalito-admin-token`, plus read access to the admin token for the `orchestrator` and `notifier` service accounts | SSO, tenants, usage reporting | CHALYB_ENGINE.md §4 |
| [ ] | Meter kinds accepted: `llm.tokens`, `voice.seconds`, `call.seconds`, `whatsapp.messages`, `sms.segments`, `compute.seconds`, and **`store.purchase` billed as already a price** (`ceil(cost_usd_micros / 4)`, like `boost.fee`) | Usage reporting (M12); paid cosmetics (M8), D-030 | CHALYB_ENGINE.md §5, `DEVIATIONS.md` D-030, decision #32 |
| [ ] | `/usage/admit`, `/usage/settle` and `reserved` in the balance merged to chalyb `main` (commit `a5733df` is on unmerged branches) | Managed AI fails closed to free_min until then (M12) | CHALYB_ENGINE.md §7b |
| [ ] | Optional: forward `next` through `/auth/launch/<slug>` and in the SSO token | Removes the `chalito_next` cookie workaround | CHALYB_ENGINE.md §8, `apps/web/src/lib/next-cookie.ts` |
| [ ] | Report Solo purchases and trial state to Chalito (see §1.1) | Solo entitlements; trial-mirrored access | `docs/integrations/CHALYB_HANDOFF.md` |
| [ ] | Flip the engine row to `active` and run `reconcileEngineLinks('chalito')` (dry run first) | Go-live | CHALYB_ENGINE.md §9 |

### 1.1 Gaps found while writing the hand-off doc
- [ ] **Trial state.** The hub doesn't expose it on balance or admit, so `hubTrialActive` is always `false` (`apps/orchestrator/README.md`, "Not yet").
- [ ] **Solo tier.** The SSO `tier` maps only `free`, `pro` and `vip` (`hubTierOf` in `packages/billing/src/caps.ts`), so `soloTier` is never set from the hub today. The hub needs to say how a Solo purchase is reported.

## 2. Supabase on the hub project nexo-ai (owner and hub sign-off)

| | What | Why / blocks | Reference |
|---|---|---|---|
| [ ] | Sign off on the shared-project items: device users in `auth.users` with a guard on `app_metadata ? 'chalito'`, `service_role` revoked from the Chalito schemas, Realtime policies scoped to `chalito:*`, `chalito` exposed in the Data API (not `chalito_private`) and kept out of pg_graphql, Realtime "Allow public access" off | Everything that touches data | CHALYB_ENGINE.md §7, `docs/reviews/supabase-review.md` (S1, S2, S4, S5, S7, S10), ADR 0017 |
| [ ] | Hub-side fence: put `supabase/hub/chalyb-hub-chalito-fence.draft.sql` into a Chalyb migration (no hub profile for device users, restrictive fence template) | Device users must not become hub users | `supabase/hub/README.md` |
| [ ] | pg_cron jobs on the shared project. `chalito-pairing-watchers` deletes from `auth.users`, but only reserved-domain pairing users over 1 h old. The others touch only Chalito's schemas: `chalito-purge-expired`, `chalito-flush-coalesced`, `chalito-cron-history`, `chalito-notification-sends`, `chalito-purge-rooms`, `chalito-purge-oauth`, `chalito-usage-outbox-purge`, `chalito-voice-call-refs-purge`, `chalito-http-rate-buckets-purge` (M15, migration 002700) | Housekeeping | `supabase/hub/README.md`, `grep cron.schedule supabase/migrations` |
| [ ] | Apply `supabase/migrations/20261004*` to nexo-ai after a dry run on a Supabase branch (currently 000100–002300 on `all`, more from M15) | Go-live | CHALYB_ENGINE.md §7 |

## 3. GCP and Terraform bootstrap

| | What | Why / blocks | Reference |
|---|---|---|---|
| [ ] | Create the GCS state bucket in Chalyb's project (versioning on, public access prevention enforced) | `terraform init` | `infra/terraform/envs/dev/README.md` |
| [ ] | Fill `backend.hcl` and `terraform.tfvars` from the examples, `terraform plan`, then **`terraform apply` with the owner's go** (billable resources in a shared project) | Chalito-only resources: service accounts, Artifact Registry, Pub/Sub, Cloud Tasks, KMS, buckets, BigQuery, Cloud Run services | same; ADR 0016 §7 |
| [ ] | After Chalyb's apply, pass its `api` service-account email to Chalito's Terraform as `api_service_account` | IAM for the engine's `api` | CHALYB_ENGINE.md §3 |
| [ ] | Cloud Scheduler jobs with OIDC: notifier `POST /tasks/drain-usage` every minute, orchestrator `POST /tasks/sweep-decisions` | Usage drain (M12), decision sweep (M9) | `packages/billing/README.md`, `apps/orchestrator/README.md` |
| [ ] | Pub/Sub push subscriptions (`notifications`, `room-events`) and the Cloud Tasks queue pointed at the notifier with OIDC | Escalation (M6) | `apps/notifier/README.md` |
| [ ] | Cloud KMS key for BYO brain keys (`BRAIN_KEYS_KMS_KEY`) | Cloud BYO turns (M9) | `apps/orchestrator/README.md` |
| [ ] | Avatar bucket (`AVATAR_BUCKET`, private) and a Cloud Run job for `avatar-jobs` | User uploads (M8) | `apps/avatar-jobs/README.md` |
| [ ] | Budget alerts on `app=chalito` resources (Terraform creates the budget; the owner confirms recipients) | Cost control | `infra/terraform/envs/dev/README.md` |

## 4. Domain and Vercel

**Update (2026-10-05):** the owner put Chalito inside the hub. Its screens are `https://www.chalyb.com/app/chalito` in the hub's own Next.js app and Vercel project; there's no `chalito.chalyb.com` and no `api.`/`mcp.` subdomain, and the services use their Cloud Run run.app URLs (Chalyb migration 0067, ADR 0015). The hub's Vercel project is on the **Hobby** plan, which is for non-commercial use; staying on it is an owner decision, to revisit before anything is sold.

| | What | Why / blocks | Reference |
|---|---|---|---|
| [x] | Domain: none of its own. Chalito is at `www.chalyb.com/app/chalito` (owner, 2026-10-05; replaces `chalito.chalyb.com`, decision #22). Own Chalito domains can come later | Web, SSO `external_url` | `docs/PLAN.md` decision #22, ADR 0015 |
| N/A | ~~Vercel project for `apps/web`~~: not needed, the screens ship with the hub. The hub's project is on Hobby (non-commercial), kept by owner decision | Web/PWA (M5) | ADR 0015 |
| N/A | ~~Separate Vercel env~~ (no separate project). Kept for reference: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable only), `NEXT_PUBLIC_CHALITO_API_BASE`, `NEXT_PUBLIC_HUB_URL=https://www.chalyb.com`. Never `NEXT_PUBLIC_CHALITO_DEV_BACKEND` (the build refuses it on Vercel) | Web | `apps/web/src/lib/env.ts` |
| N/A | ~~Cloud Run domain mappings~~: none. The api and the MCP gateway keep their run.app URLs (`docs/GO_LIVE.md` "Where Chalito lives") | api, MCP gateway | ADR 0015 |

## 5. Secrets (Secret Manager)

Nothing here is committed. Each value goes into Secret Manager in Chalyb's project and is mounted only on the services listed.

**Wiring:** `infra/terraform/envs/dev/main.tf` creates the containers and mounts each one under the env name the code reads (R-L12). `packages/config/test/terraform-env.test.ts` fails if a required name is missing or misnamed. Containers to fill:
- `chalito-database-url` (created by Chalyb's engine module as a `REPLACE_ME` placeholder; Chalito's Terraform grants the notifier and orchestrator access), `chalito-gateway-database-url`;
- `chalito-gateway-token`, `chalito-supabase-secret-key`, `chalito-voice-token-secret`;
- `chalito-vapid-private-key`, `chalito-openai-webhook-secret`, `chalito-voice-ref-secret`;
- the Twilio, Meta, OpenAI, Anthropic and xAI ones, and `chalito-owner-uids`.

**Database URLs (transaction pooler, 2026-10-19):** both point at Supavisor's transaction pooler (port 6543), each with its own login whose default role is the service role, so no startup `role` parameter is needed (`packages/config/src/database.ts`; the services check `current_user` at start and refuse to serve as anyone else):
- `chalito-database-url`: `chalito_server_login.<project-ref>`, `noinherit in role chalito_server`, `alter role chalito_server_login set role = 'chalito_server'`;
- `chalito-gateway-database-url`: `chalito_gateway_login.<project-ref>`, the same with `chalito_gateway`.
A URL on another port keeps the session behaviour (startup `role`, prepared statements); `DATABASE_POOL_MODE=transaction|session` overrides the port.

**api (Chalyb's engine module) also needs:**
- `ACCOUNT_EXPORT_BUCKET`: the records bucket (CMEK) is the suggested home for `exports/<owner>/`;
- `AVATAR_BUCKET`: the assets bucket (also turns on `/v1/avatar`, custom companions, with `CHALYB_BASE_URL`); the api signs upload URLs as itself, so its account needs Token Creator on itself (`api_self_sign` in Terraform); it also deletes a card's every object version when the person deletes their character ("Eliminar mi personaje", `docs/RUNBOOK.md` 6.8), which `roles/storage.objectAdmin` on the bucket (`api_objects`) covers;
- `RECORDS_BUCKET`;
- `API_PUBLIC_URL`;
- `SCHEDULER_SA_EMAIL`;
- `TRUSTED_PROXIES`: 0 behind Cloud Run's front end, 1 behind an external load balancer;
- `PAIRING_ORIGINS` (optional): origins a pairing loopback proof may name (ADR 0028 §4); unset = `https://www.chalyb.com`. Set a local or preview hub only on a dev deployment;
- `AVATAR_FREE_MARKER_KEY` (secret, recommended, ≥ 32 random characters, e.g. `openssl rand -hex 32`): keys the free-custom-companion markers (migration `20261005000200`, `apps/api/src/avatar/free-marker.ts`). Without it the api derives a key from `CHALITO_SSO_SECRET`. **Set it once and don't rotate it:** a new key forgets who already used their free creation (each person could get one more).

**Cloud Scheduler:** schedule `POST <api>/tasks/account-deletions` hourly, with OIDC as `SCHEDULER_SA_EMAIL`.

**Set by variables:**
- `hub_admin_token_secret`: the id of Chalyb's `CHALITO_ADMIN_TOKEN` secret. Chalito's Terraform grants the notifier and orchestrator access to it and to `chalito-database-url` (`hub_secret_read`).
- `notifier_public_url` and `orchestrator_public_url`;
- `supabase_url`, `vapid_public_key`, `realtime_sip_uri`.

| Secret / env | Services | Where to get it |
|---|---|---|
| `CHALITO_SSO_SECRET` | api | Shared with the hub (`chalito-sso-secret`; Vercel env on the hub) |
| `CHALITO_ADMIN_TOKEN` | api, notifier, orchestrator | Shared with the hub (`chalito-admin-token`) |
| `HUB_RESERVE_BASIS` (plain env, optional) | api, notifier, orchestrator | `pre_margin` (default) or `post_margin`: whether the hub adds the margin to an admit's `est_tokens` (GO_LIVE 1.6a). Anything else stops the service at boot |
| `DATABASE_URL` (login that can `SET ROLE chalito_server`; `chalito_gateway` for the gateway) | api, notifier, orchestrator, mcp-gateway | nexo-ai Postgres; roles from the migrations |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | api, orchestrator | nexo-ai project settings (secret key, server only) |
| `VOICE_TOKEN_SECRET` | api | `chalito-voice-token-secret`. Generate: 32 random bytes |
| `CHALITO_GATEWAY_TOKEN` | api, mcp-gateway | Generate: 32 random bytes, the same value on both |
| `OPENAI_API_KEY` | api (desktop voice), notifier (SIP), orchestrator | OpenAI org account |
| `OPENAI_WEBHOOK_SECRET` | notifier | OpenAI dashboard, `realtime.call.incoming` webhook |
| `VOICE_REF_SECRET` | notifier | Generate: 32 random bytes |
| `ANTHROPIC_API_KEY` | orchestrator | Anthropic org account (managed brains) |
| `XAI_API_KEY` | orchestrator (optional) | xAI account |
| Vertex via ADC (`GOOGLE_CLOUD_PROJECT`) | orchestrator | Service-account IAM, no key file |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | api (Verify), notifier (calls, SMS) | Twilio console |
| `TWILIO_VERIFY_SERVICE_SID` | api | Twilio Verify service |
| `TWILIO_FROM` | notifier | The purchased number (§7) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | notifier | Meta system-user token; Cloud API number id |
| `META_APP_SECRET`, `META_VERIFY_TOKEN` | notifier | Meta app settings; the verify token is generated |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | notifier | `npx web-push generate-vapid-keys`; subject is a mailto: or https URL |
| `BRAIN_KEYS_KMS_KEY` | orchestrator | KMS key resource name (§3); not a secret value |
| `OWNER_UIDS` | api, notifier, orchestrator | The owner's hub user ids (comped) |
| `REALTIME_SIP_URI` | notifier (optional) | `sip:<proj>@sip.api.openai.com;transport=tls;secure=true` |
| `GEMINI_API_KEY` | `avatar-jobs`: the roster scripts (local) and, deployed as Secret Manager `chalito-gemini-api-key`, custom companions from a photo | Google AI Studio (`~/.config/secrets/ai.env` on the owner's machine). **Must be a key from a paid-tier AI Studio project (Cloud Billing enabled on it).** Under the Gemini API terms, content sent through unpaid (free-tier) keys may be used to improve Google's products; paid-tier content isn't. User photos go through this key, and the privacy text promises they aren't used for training, so a free-tier key here breaks that promise. Check in AI Studio → API keys that the key's project shows a paid tier before deploying, and again after any key rotation. |
| Release secrets (Apple, Azure, Tauri updater) | GitHub Actions only | §10 (M14) |

## 6. Meta / WhatsApp

| | What | Why / blocks | Reference |
|---|---|---|---|
| [ ] | Meta Business verification. Unverified businesses are limited to 250 recipients/day | WhatsApp rung (M6) | `docs/VERIFIED_APIS.md` (WhatsApp row) |
| [ ] | Register the phone number on the Cloud API; create a system-user token | Sending | `apps/notifier/README.md` |
| [ ] | Submit the `chalito_pendientes_v1` utility template (ES `es_MX`, EN `en_US`) and get it approved | Templates are the only out-of-window messages | `apps/notifier/templates/chalito_pendientes_v1.json`, ADR 0011 |
| [ ] | Webhook: point it at the notifier's `/webhooks/whatsapp` (`PUBLIC_BASE_URL`), set the verify token and app secret. Note: ADR 0015 says webhooks go to `api.`, but the code serves them from the notifier, which the README explains | Acks and opt-outs | `apps/notifier/README.md`, `apps/notifier/src/app.ts` |

## 7. Twilio

| | What | Why / blocks | Reference |
|---|---|---|---|
| [ ] | Buy the calling number: US local (about $1.15/mo, assumed in the docs) or MX local (about $6.25/mo). Decision #17 is pending | Calls and SMS (M6) | `docs/PLAN.md` #17, brief §11 |
| [ ] | Geo Permissions: only the testers' countries (Mexico at least) | Toll-fraud control | `docs/THREAT_MODEL.md` (toll fraud), `apps/notifier/README.md` |
| [ ] | Verify service for phone OTP (`TWILIO_VERIFY_SERVICE_SID`) | `/v1/phone` (M6) | `apps/api/src/phone/` |
| [ ] | A2P 10DLC registration before any US SMS | US SMS | ADR 0011 |
| [ ] | Usage alerts and daily caps in the Twilio console | Toll-fraud control | `docs/THREAT_MODEL.md` |
| [ ] | Status, gather and SMS webhooks pointed at the notifier with signature validation | Call menu, acks | `apps/notifier/README.md` |

## 8. AI providers

| | What | Why / blocks | Reference |
|---|---|---|---|
| [ ] | Anthropic, OpenAI, xAI and Google (Vertex) org accounts and keys for managed tokens | Managed brains (M9) | brief §11, `apps/orchestrator/README.md` |
| [ ] | **Codex: submit OpenAI's Sign in with ChatGPT (SIWC) partner interest form.** Until approved, `providers.yaml` keeps `openai.subscriptionLocal: owner_only`; flip it to `approved` after | ChatGPT-plan Codex for all users (M4) | `DEVIATIONS.md` D-003, `packages/config/providers.yaml`, decision #26 |
| [ ] | Optional: ask Anthropic about subscription logins in a third-party product (today API key only, `subscriptionLocal: off`) | Claude Code BYO via subscription | D-002, decision #19 |
| [ ] | **Recipe catalog signing key (connect engine).** Make the production Ed25519 key offline (`pnpm recipes keygen --id prod-2026-1 --out <offline path>`), keep the secret key off every server and repo (password manager / HSM), and add only its public key to `CATALOG_KEYS` in `apps/agent/src/apps/catalog-keys.ts` (a release that ships it). Then each catalog update: `pnpm recipes build --bump`, review, `pnpm recipes sign --key <offline key> --out catalog.signed.json`, publish that file where the api reads `CHALITO_RECIPE_CATALOG_FILE`. Until then agents use only the catalog built into them and ignore a served one (the dev key in `recipes/test-fixtures/` is never trusted). | Curated recipe updates without an agent release | D-064, `recipes/`, `apps/agent/scripts/recipes.ts` |
| [ ] | Review the curated recipes' unverified fields (each `recipes/<id>.yaml` lists them under `verification.unverified`), especially Windows AUMIDs/paths for desktop apps and web-app login origins | Detection and launch accuracy | D-064, `docs/VERIFIED_APIS.md` "Connect engine recipes" |

## 9. Prices awaiting the owner

| | What | Why / blocks | Reference |
|---|---|---|---|
| [ ] | Confirm the paid cosmetic prices (placeholders, in hub tokens): `star_cape` 1000, `sparkle_aura` 1000, `portal_swirl` 2000, and the seven skins `skin_*` 10000 each (scale: one clothing item ≈ 200, a full outfit ≈ 5,000) | Paid store items (M8); also needs the hub's `store.purchase` change (§1) | `packages/config/catalog.yaml`, `docs/integrations/STORE.md`, D-030 |
| [ ] | MXN charge amounts for each Solo tier on the hub (`billing.soloMxnAmounts: unset`). Solo checkout shows "Disponible pronto" until set | Solo line (M12/M13) | `packages/config/plans.yaml`, D-031, decision #31 |
| [ ] | Review the progressive inclusions per tier | Margins | decision #1, D-009, `packages/config/plans.yaml` |

## 10. M14: downloadable apps

> From picassoglitch-76. This matches `m14-apps` 9691094 (`.github/workflows/release.yml`, `apps/desktop/scripts/release`, `infra/terraform/envs/dev/releases.tf`).

**0. Api host (First Run, ADR 0028; owner).** Release builds, the desktop CSP and the updater use `https://api.chalito.chalyb.com`, which doesn't resolve yet (ADR 0015's 2026-10-05 update removed subdomains; owner decision #49 brings this one back). Before any real release:
- Map the `chalito` Cloud Run service (`us-central1`) to `api.chalito.chalyb.com`: `gcloud beta run domain-mappings create --service chalito --domain api.chalito.chalyb.com --region us-central1` (verify `chalyb.com` in Search Console first if gcloud asks).
- Add the DNS record it prints (a `CNAME` to `ghs.googlehosted.com.`) at the `chalyb.com` DNS host, and wait for the managed certificate.
- Check: `curl -fsS https://api.chalito.chalyb.com/health`.

Until these are done, tag builds still produce DRAFT releases, labelled unsigned (`UNSIGNED_` file names, `unsigned` in latest-v2.json, a note in the draft). Nothing is ever published automatically.

**1. Updater signing key (required before any real release).**
- On a trusted machine: `pnpm --filter @chalito/desktop exec tauri signer generate -w ~/.tauri/chalito-updater.key` (use a strong password).
- Store the private key file content as the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`, and the password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Store the public key file content (`.key.pub`) as the repository **variable** `TAURI_UPDATER_PUBKEY`.
- Keep an offline backup of the private key and password. Losing them means installed apps can never be updated again. Never commit either.
- Without the secret, every run uses a throwaway test key and its draft says not to publish it.

**2. Releases bucket + URL signer (Terraform, Chalyb's GCP project).**
- The private bucket `<project>-chalito-releases` already exists in `modules/storage` (uniform access, public access prevention enforced).
- Apply `infra/terraform/envs/dev/releases.tf`. It creates the `chalito-release-signer` service account (objectViewer on that bucket only, no keys) and gives the api's service account (`api_service_account` variable) Token Creator on the signer.
- Set on the api's Cloud Run service: `CHALITO_RELEASES_BUCKET` and `CHALITO_RELEASES_SIGNER` (both are outputs of the apply). Without them, `/releases/...` isn't served and /descargar says downloads aren't available.

**2b. Desktop account wiring (repository variables).** `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (public values; a secret key is refused) become `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` in the release build, with `VITE_CHALITO_API_BASE` from the workflow. A release refuses to build without them; a dry run is labelled "UNWIRED".

**3. Apple (macOS signing + notarization, D-011).**
- An Apple Developer Program membership.
- Create a **Developer ID Application** certificate. Export it as a .p12 and set `APPLE_CERTIFICATE` (base64 of the .p12), `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Name (TEAMID)`).
- In App Store Connect, under Users and Access → Integrations → Team keys, create an API key with Developer access. Set `APPLE_API_ISSUER` (issuer id), `APPLE_API_KEY` (key id), and `APPLE_API_PRIVATE_KEY` (the content of the AuthKey .p8).
- The certificate alone is refused: the build won't sign without notarization.

**4. Windows (Azure Artifact Signing). Owner, 2026-10-16: not used for now; Windows ships unsigned (ADR 0014 update). Kept here in case that changes.**
- Create an Azure Artifact Signing (formerly Trusted Signing) account, complete its identity validation, and create a certificate profile (public trust).
- Create an app registration with the "Artifact Signing Certificate Profile Signer" role on the profile.
- Set the secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, and the repository variables `ARTIFACT_SIGNING_ENDPOINT` (e.g. `https://wus2.codesigning.azure.net`), `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE`.
- Expect SmartScreen warnings until reputation builds (/descargar explains this).
- **Plan (owner decision #24, 2026-10-16):** beta and internal builds ship unsigned on the beta channel. Set this up before the public launch (an OV certificate instead if the account isn't eligible).

**5. Linux (optional): AppImage GPG.**
- Generate a signing key. Set `APPIMAGE_GPG_PRIVATE_KEY` (the armored private key), `APPIMAGE_SIGN_KEY` (key id), `APPIMAGETOOL_SIGN_PASSPHRASE`.
- Publish the public key and checksums next to the downloads. deb/rpm stay unsigned in beta.

**5b. Public app config (required for a release).**
- Set the repository **variables** (not secrets; both values are public): `SUPABASE_URL` (the project URL, `https://<ref>.supabase.co`) and `SUPABASE_PUBLISHABLE_KEY` (the publishable key, `sb_publishable_…`, never the secret key; the workflow refuses `sb_secret_…`). The api base comes from `CHALITO_API_BASE` in release.yml.
- They become the desktop's `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` and `VITE_CHALITO_API_BASE`. Without them the app builds with no account wiring (no sign-in, rooms or voice).
- A tag release refuses to build without them. A dry run builds anyway, warns, names its artifacts `release-<os>-unwired`, adds `UNWIRED-<os>.txt`, and says so in the summary.

**6. Dry run, then a release (owner's go).**
- Actions → Release → "Run workflow" builds everything, verifies every updater signature, checks the labels, and produces artifacts plus a `latest-v2.json`. No release is created.
- To release: push a tag `vX.Y.Z` (or `vX.Y.Z-beta.N` for the beta channel). The workflow creates a DRAFT GitHub release with all installers and `latest-v2.json`. The bridge release (0.1.0-beta.13) also carries `latest.json`.
- Publishing is manual and needs the owner's go:
  - check the draft;
  - upload its files to `gs://<project>-chalito-releases/<channel>/<version>/`;
  - upload `latest-v2.json` to `gs://<project>-chalito-releases/<channel>/latest-v2.json` (this is what makes installed apps update, and what /descargar shows);
  - only for the bridge release (0.1.0-beta.13): also upload its `latest.json` to `gs://<project>-chalito-releases/<channel>/latest.json`. Builds before the bridge ask for that file; it stays frozen at the bridge so they never get a later build. Never upload `latest.json` again;
  - publish the GitHub draft.
- Never publish a draft that says "THROWAWAY test key", "UNWIRED", or (for a public release) "UNSIGNED".

**7. Claude Code is NOT bundled (what the person installs; how the agent detects it).**
- The desktop installers ship the Chalito agent as a sidecar, but not Anthropic's `claude` CLI: about 250 MB per platform, its own updates and its own terms (VERIFIED_APIS §8).
- The app runs that sidecar itself while it's open (`src-tauri/src/agent.rs`). It starts `chalito-agent run` once `~/.chalito/config.json` names an owner and a device, restarts it with backoff (1 s doubling to 5 min) when it crashes, and stops it on quit. Its output goes to the app's log folder (`agent.log`, rotated at 5 MB). It never runs a second agent: `run` exits 75 when one already holds `~/.chalito/agent.lock` (the OS service), and 78 when a setup step is missing, and then the app waits for the config to change.
- The panel talks to that agent over a local IPC (`apps/agent/src/ipc-server.ts`, `src-tauri/src/ipc_client.rs`): `~/.chalito/agent.sock` (0600; a per-user named pipe on Windows), never a TCP port. Each request carries a secret the app makes per launch and writes to the agent's stdin (`CHALITO_IPC=stdin`). An agent the app didn't start (the OS service) serves no IPC, and the Security tab says the agent isn't answering. Through it the panel shows the signed policy, reports presence, and turns Developer mode toggles off, or on with the CLI's rules: only `allowSudo`, `autoApproveHigh` and `autoApproveCritical`, OS auth by the agent itself, and all three answers plus the typed phrase re-checked. Windows has no OS auth for this yet, so enabling there is refused (`os_auth_failed`). The pairing reverse check stays in `chalito pair`'s terminal.
- Panel → Security → "Instalar el comando chalito" puts the sidecar on PATH as `chalito` after the person confirms (`src-tauri/src/cli_install.rs`):
  - Linux: a `~/.local/bin/chalito` link. An AppImage's sidecar is first copied to `~/.local/share/chalito/`, and the app refreshes that copy at start.
  - macOS: a `/usr/local/bin/chalito` link, through the administrator prompt. It's refused while the app runs from the DMG or a translocated copy.
  - Windows: a `chalito.cmd` shim in `%LOCALAPPDATA%\Chalito\bin`, added to the user PATH.
  - An existing `chalito` that isn't Chalito's is never replaced.
- What the person does:
  1. Install Claude Code with Anthropic's official installer (https://code.claude.com/docs/en/setup).
  2. Then either run `chalito keys set anthropic` (if `claude` is on PATH and the computer is paired, the agent pins it automatically), or run `chalito claude pin [path]` in a terminal.
- After Claude Code updates itself, run `chalito claude pin` again.
- How the agent detects it:
  - The agent never looks `claude` up on PATH at run time. It runs only the PINNED binary: path (symlinks resolved) plus sha256, in the signed config.json.
  - At daemon start, `checkClaudePin` refuses to start if the pin is missing, the file is gone, it's world-writable, or the hash changed.
  - It shows the person exactly what to do in their locale ("No Claude Code (`claude`) is pinned. Install it … then run `chalito claude pin`" / "Claude Code updated itself: run `chalito claude pin` again").
  - `chalito status` shows the pin state.
- [ ] **Owner item:** decide before a public release whether a later version embeds `claude` as a second signed `externalBin`. That would need macOS notarization of that binary, and checking Anthropic's redistribution terms.

**OS keychain** (from `m7-endorse-agents` 113d0d4): if a build's OS-keychain component is missing, the agent refuses to start and tells the person to reinstall from /descargar (CLI exit 3). It never stores keys elsewhere. Headless Linux without a Secret Service still uses the passphrase-encrypted `~/.chalito/secrets.enc`.

## 11. Runs that cost money or are externally visible (owner's go each time)

| | What | Cost / visibility | Reference |
|---|---|---|---|
| [ ] | **The 1k-device load test against a real dev project** (1k devices plus room fan-out). CI runs only the small local version | Supabase Realtime and Cloud Run usage on a shared project | `docs/LOAD_TEST.md`, `docs/PLAN.md` M15 (Risks) |
| [ ] | **One real call and one real WhatsApp template** (notifier runbook) | Twilio and Meta charges, a real phone rings | `apps/notifier/README.md` (Runbook) |
| [ ] | The Claude Code end-to-end run against the dev cloud (the local stack is the default) | Externally visible | `scripts/e2e-claude.md` |
| [ ] | `terraform apply` in either repo | Billable resources | §3, §1 |
| [ ] | Regenerating roster art (at most 40 Gemini calls per run, provenance logged) | Gemini API usage | `apps/avatar-jobs/README.md`, `docs/ASSET_PROVENANCE.md` |

## 12. Other pending owner decisions

| | Decision | Status | Reference |
|---|---|---|---|
| [ ] | #14 Native phone apps | Pending (PWA meanwhile) | `docs/PLAN.md` |
| [ ] | #17 Twilio number | Pending (§7) | `docs/PLAN.md` |
| [ ] | #24 Windows signing | Pending (§10) | `docs/PLAN.md` |
| [ ] | Rigged VRM avatars after beta | Out of scope for beta | `DEVIATIONS.md` D-060 |
| [ ] | Desktop panel step-up for HIGH/CRITICAL approvals | Not in beta | `DEVIATIONS.md` D-059 |
| [ ] | Legal review: ToS and privacy (ES/EN), Developer-mode liability text, upload/IP terms, refund terms | Before public launch | brief §11, `packages/config/legal/devmode-liability.{es,en}.md`, `docs/LEGAL_CHECKLIST.md` |

## 13. Managed coding agents: "IA de Chalyb" (ADR 0030)

Codex and Gemini CLI on Chalyb's keys, billed to the person's Chalyb tokens. Never Claude Code; Grok Build is pending (below). Every step below is the owner's to run. Commands assume `PROJECT`, `REGION=us-central1`, the Chalito repo at `~/chalito` and Chalyb's at `~/chalyb`.

**Order:** merge the Chalito PRs in sequence (config → migration → billing → api → ai-gateway → agent → this runbook), then Chalyb's hub UI PR. Deploy in the order below. Both switches stay off until step 8.

| # | Step | Command | Check | Undo |
|---|---|---|---|---|
| 1 | Migration `20261021002000_chalito_coding_managed.sql` reaches nexo-ai only through a hub PR (GO_LIVE 2.4). It adds 3 tables and the `chalito_ai_gateway` role, adds policies on `chalito.users`, `chalito.devices` and `chalito_private.usage_outbox` (each a brief exclusive lock, under a second; run it off-peak), and replaces `valid_connection_doc` to accept the `chalyb` connect method | `cp ~/chalito/supabase/migrations/20261021002000_chalito_coding_managed.sql ~/chalyb/supabase/migrations/`, open the hub PR, then in Chalyb after merge: `pnpm db:link && supabase db push --include-all` | `select rolname from pg_roles where rolname = 'chalito_ai_gateway';` → 1 row; `select count(*) from cron.job where jobname = 'chalito-coding-spend-purge';` → 1 | Forward-only: a corrective migration. While empty: `drop table chalito_private.coding_credentials, chalito.coding_settings, chalito.coding_spend_daily;` |
| 2 | The gateway's database login (SQL editor, as postgres). Generate the password with `openssl rand -hex 24` | `create role chalito_ai_gateway_login login password '<pw>' noinherit in role chalito_ai_gateway; alter role chalito_ai_gateway_login set role = 'chalito_ai_gateway';` | The URL is `postgresql://chalito_ai_gateway_login.<project-ref>:<pw>@<pooler-host>:6543/postgres`; the service refuses to start unless `current_user` is `chalito_ai_gateway` | `drop role chalito_ai_gateway_login;` |
| 3 | Provider keys from projects used for nothing else, each with its own spend limit and alert | **OpenAI:** platform.openai.com → new project `chalyb-coding` → API key for that project only; Limits → monthly budget and email alert. **xAI:** console.x.ai → new team `chalyb-coding` → API key; Billing → spending limit. **Google:** `gcloud projects create chalyb-coding-gemini && gcloud billing projects link chalyb-coding-gemini --billing-account=<BILLING>` (paid tier, so prompts aren't used for training), `gcloud services enable generativelanguage.googleapis.com --project=chalyb-coding-gemini`, `gcloud services api-keys create --project=chalyb-coding-gemini --display-name=chalito-coding --api-target=service=generativelanguage.googleapis.com`, then the budget: `gcloud billing budgets create --billing-account=<BILLING> --display-name=chalyb-coding-gemini --budget-amount=<AMOUNT> --filter-projects=projects/chalyb-coding-gemini --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0` | Each key answers in its console's playground; nothing else uses these projects | Revoke the key in its console |
| 4 | Terraform creates the service account, the secret containers and `chalito-ai-gateway` (public, CPU always on, kill switch off) | `cd ~/chalito/infra/terraform/envs/dev && terraform plan -out ai.plan && terraform apply ai.plan` | The plan adds the `chalito-ai-gateway` account, the `chalito-ai-gateway-database-url` and `chalito-coding-{openai,xai,gemini}-key` secrets and `module.ai_gateway`, and changes nothing else | `terraform destroy -target=module.ai_gateway` (turn deletion protection off first) |
| 5 | Secret values | `printf %s '<url from 2>' \| gcloud secrets versions add chalito-ai-gateway-database-url --project=$PROJECT --data-file=-`, and the same for `chalito-coding-openai-key`, `chalito-coding-xai-key` and `chalito-coding-gemini-key` | `gcloud secrets versions list <id> --project=$PROJECT` | Disable the version |
| 6 | Build and deploy the gateway, no traffic first (RUNBOOK §1.2) | `docker build -f docker/service.Dockerfile --build-arg APP=ai-gateway -t $REGION-docker.pkg.dev/$PROJECT/chalito/ai-gateway:$(git rev-parse --short HEAD) . && docker push $REGION-docker.pkg.dev/$PROJECT/chalito/ai-gateway:$(git rev-parse --short HEAD)`, then `gcloud run deploy chalito-ai-gateway --image $REGION-docker.pkg.dev/$PROJECT/chalito/ai-gateway:<sha> --region $REGION --no-traffic --tag canary`, `curl -fsS https://canary---<service-host>/health`, `gcloud run services update-traffic chalito-ai-gateway --to-latest --region $REGION` | `/health` → `{"ok":true}`; a request without a token → 401 | `gcloud run services update-traffic chalito-ai-gateway --to-revisions <previous>=100 --region $REGION` |
| 7 | The api learns the gateway's URL, switch still off. The api's env lives in Chalyb's engine module: add both there (hub patch 06), or for now: | `gcloud run services update chalito-api --region $REGION --update-env-vars CHALITO_AI_GATEWAY_URL=https://<chalito-ai-gateway host>,CODING_MANAGED_ENABLED=0` | `GET /v1/coding/settings` (signed in) → `"enabled": false` | Remove `CHALITO_AI_GATEWAY_URL`: `/v1/coding` is no longer mounted |
| 8 | **Turn it on** (owner's go): the gateway, then the api | `gcloud run services update chalito-ai-gateway --region $REGION --update-env-vars CODING_MANAGED_ENABLED=1` (and `coding_managed_enabled = true` in tfvars so the next apply keeps it), then `gcloud run services update chalito-api --region $REGION --update-env-vars CODING_MANAGED_ENABLED=1` | On the owner's Pro/VIP account: Codex → "IA de Chalyb", start a session; `select source_id, event->>'cost_usd_micros' from chalito_private.usage_outbox where source_id like 'coding:%' order by id desc limit 5;` shows its requests, and the hub's Uso line moves. Repeat with Gemini CLI | Step 9 |
| 9 | **Kill switch** | `gcloud run services update chalito-ai-gateway --region $REGION --update-env-vars CODING_MANAGED_ENABLED=0`, and the same on `chalito-api` | The next request of every session is 503 `managed_disabled` and its token is revoked; the sweep settles the holds within a minute: `select count(*) from chalito_private.coding_credentials where settled_at is null and (revoked_at is not null or expires_at < now());` → 0 | Step 8 |

**Watch, daily while it's new:**
- Usage the hub refused: `select count(*) from chalito_private.usage_outbox where source_id like 'coding:%' and status = 'dead';` → 0.
- Requests billed without the provider's numbers (a stream cut before its usage, billed at the worst-case input): `select count(*) from chalito_private.usage_outbox where source_id like 'coding:%' and event->'metadata'->>'estimated' = 'true' and created_at > now() - interval '1 day';`
- Provider cost per agent today, to compare with each provider's dashboard: `select agent, sum(cost_usd_micros) / 1e6 as provider_cost, sum(requests) from chalito.coding_spend_daily where day = current_date group by agent;`
- Each provider project's alert (step 3) is the backstop if metering is ever wrong.

**Rotating a provider key:** add the new secret version (step 5), run `gcloud run services update chalito-ai-gateway --region $REGION` to pick it up, then revoke the old key in the provider's console. Sessions keep their Chalyb tokens; nothing changes for the person.

**Decisions waiting on the owner:**
- Managed Grok Build is off: its `XAI_API_KEY` (the session token) sits in the environment its tools inherit, and that its inference goes only to our gateway isn't proven. Turning it on needs both fixed (a providers.yaml `managed` block plus the agent's and hub's app lists). Its `chalito-coding-xai-key` secret can stay empty.
- The hub allows Pro one active stream (`TIER_CAPS.PRO.activeStreams`, shared with desktop voice) and VIP five. Each managed session holds one, so a Pro user gets one managed session at a time. Raise Pro's cap in Chalyb, or accept it.
- The daily cap ceilings (`codingManaged.dailyCap.ceiling` in providers.yaml): Pro 5,000,000 and VIP 12,500,000 billable tokens (about 20 and 50 dollars a day). The default is 1,250,000 (about 5).
- Only priced models can be allowed: Codex runs `gpt-5.6-luna`, Gemini `gemini-3.1-flash-lite`. Better coding models need verified prices in prices.yaml first.
