# Go live: from zero to a private beta

One ordered checklist for the owner. Do the phases in order; a phase only starts when the one before it verifies. It consolidates `docs/OPS.md`, `docs/RUNBOOK.md`, `docs/integrations/CHALYB_ENGINE.md` §§1–9, the owner items in `DEVIATIONS.md` and the READMEs. Where this file and those disagree, those are more detailed; this one is the order.

**Tags**
- **[cost]** spends money (a purchase, a subscription, or billable cloud or provider usage).
- **[visible]** is visible outside: a third party sees it, a phone rings, or a public URL changes.
- **Who** is **Owner** (you), **Hub** (whoever merges in `picassoglitch/chalyb`), or **Ops** (whoever runs the commands, possibly you).

Commands assume `PROJECT` = Chalyb's GCP project, `REGION=us-central1`, and a shell in the repo root (`~/chalito`) or in Chalyb's repo where noted.

---

## Phase 0: Decisions (Owner, no cost)

| # | Step | Where | Verify | Rollback |
|---|---|---|---|---|
| 0.1 | Confirm the paid cosmetic prices (hub tokens): `star_cape` 250000, `sparkle_aura` 150000, `portal_swirl` 400000 | edit `packages/config/catalog.yaml`, PR | `pnpm test` (catalog and pay-to-win tests) | revert the PR |
| 0.2 | Set the MXN amount for each Solo tier on the hub (D-031). Until then, Solo checkout shows "Disponible pronto" | hub pricing config (Chalyb) | Solo tiers show prices on the hub | unset them; Chalito falls back to "Disponible pronto" |
| 0.3 | Review the progressive inclusions per tier (decision #1, D-009) | `packages/config/plans.yaml` | `pnpm test` (plans schema) | revert |
| 0.4 | Domain: keep `chalito.chalyb.com` (decision #22), or pick another | ADR 0015 | written in `docs/PLAN.md` decisions | — |
| 0.5 | Twilio number: US local (about $1.15/mo) or MX local (about $6.25/mo) (decision #17) | `docs/PLAN.md` | written down | — |
| 0.6 | Legal positions for the beta: who the data controller is (Chalyb or your entity), whether to block EU users, how long to keep audit logs | `docs/LEGAL_CHECKLIST.md` | answers recorded there | — |
| 0.7 | Choose the beta testers and their hub user ids. Your own ids go in `OWNER_UIDS` (comped) | — | a list | — |

## Phase 1: The Chalyb hub PR (Hub, Owner's go) [visible]

Everything here happens in `picassoglitch/chalyb`, on its own branch and PR (`docs/integrations/CHALYB_ENGINE.md`). Nothing here has been applied yet.

| # | Step | Command / where | Verify | Rollback |
|---|---|---|---|---|
| 1.1 | Engine definition `chalito` (§1) | `src/lib/engines/integrations/definitions.ts` | hub typecheck and tests | revert |
| 1.2 | Engine row migration, `coming_soon` (§2) | `node scripts/new-engine.mjs chalito "Chalito" --icon 🐻 --tier PRO`, then edit the description | the row exists with status `coming_soon` | `coming_soon` hides it; delete the row if needed |
| 1.3 | Infra entry with the domain override: `chalito.chalyb.com` → Vercel, `api.chalito.chalyb.com` → Cloud Run (§3) | `infra/terraform/terraform.tfvars` in Chalyb | `terraform plan` shows the `chalito` service account, secrets, Cloud Run `api` and the `api.` mapping only | remove the entry, re-apply |
| 1.4 | Secrets `chalito-sso-secret` and `chalito-admin-token`, plus read access for Chalito's `notifier` and `orchestrator` service accounts (§4) | Chalyb Terraform, or a one-line IAM binding | `gcloud secrets get-iam-policy chalito-admin-token` lists both service accounts | remove the bindings |
| 1.5 | Meter kinds accepted, and **`store.purchase` billed as already a price** (`ceil(cost_usd_micros / 4)`, D-030) (§5) | hub `/usage` route and billing formula | hub test posting each kind | revert |
| 1.6 | **Required:** `/usage/admit`, `/usage/settle` and `reserved` in the balance on chalyb `main` (commit `a5733df` is on unmerged branches) (§7b). Without them, managed AI fails closed to `free_min` | merge the consumption-caps work | `curl -s -X POST https://www.chalyb.com/api/engines/chalito/usage/admit -H "authorization: Bearer $CHALITO_ADMIN_TOKEN" -H 'content-type: application/json' -d '{}'` gives 400 (validation), **not 404** | revert the merge (Chalito falls back to free_min) |
| 1.7 | Optional: forward `next` through `/auth/launch/chalito` (§8, and §8b if present) | hub launch route | `/n/<nid>` lands on the right screen after sign-in, without the cookie | Chalito's `chalito_next` cookie keeps working |
| 1.8 | Report Solo purchases and trial state to Chalito (CHALYB_HANDOFF §6.5). Until then, Solo entitlements and trial-mirrored access don't flow | hub balance, admit, or SSO payload | `docs/integrations/CHALYB_HANDOFF.md` gaps closed | — |
| 1.9 | Hub-side fence: turn `supabase/hub/chalyb-hub-chalito-fence.draft.sql` (this repo) into a Chalyb migration | Chalyb `supabase/migrations` | a device user creates no hub profile (Phase 2 dry run) | revert the migration |
| 1.10 | `terraform apply` in Chalyb **[cost]** | Chalyb `infra/terraform` | outputs include the `api` service-account email | `terraform destroy -target=…` for the engine module |
| 1.11 | Set the secret values for `chalito-sso-secret` and `chalito-admin-token`: 32 random bytes each, the same values in the hub's Vercel env | `printf %s "$(openssl rand -base64 32)" \| gcloud secrets versions add chalito-sso-secret --data-file=-` (same for the admin token) | `gcloud secrets versions list …` | disable the version |

## Phase 2: Supabase on nexo-ai (Owner + Hub sign-off) [visible]

The hub's project is shared, so its owner signs off first (`docs/reviews/supabase-review.md` S1, S2, S4, S5, S7, S10; CHALYB_ENGINE §7).

| # | Step | Command / where | Verify | Rollback |
|---|---|---|---|---|
| 2.1 | Sign off on the shared-project items: device users in `auth.users` behind `app_metadata ? 'chalito'`, `service_role` revoked from the Chalito schemas, Realtime scoped to `chalito:*`, `chalito` exposed in the Data API (not `chalito_private`) and kept out of pg_graphql | review | written sign-off | — |
| 2.2 | **Dry run on a Supabase branch first** [cost]. Branch nexo-ai, then push this repo's migrations to the branch | Dashboard → Branches → Create branch (or `supabase branches create go-live-dryrun --project-ref <nexo-ai ref>`; check `supabase branches --help` for your CLI version), then `supabase db push --db-url "<branch db url>"` | `supabase migration list --db-url "<branch db url>"` shows every `20261004*` as applied; run `supabase test db` against the branch; run `scripts/staging-smoke.ts` (Phase 7) pointed at the branch, if services point there | delete the branch |
| 2.3 | Check hub behaviour on the branch: sign in to the hub; create a Chalito device user (pair once) and confirm no hub profile appears; the hub's own Realtime still works | manual | as stated | delete the branch |
| 2.4 | Apply to nexo-ai [visible] | `supabase link --project-ref <nexo-ai ref> && supabase db push` | `supabase migration list` is all applied; `select count(*) from cron.job where jobname like 'chalito-%'` matches `grep -c cron.schedule supabase/migrations/*` | migrations are forward-only (RUNBOOK §2.3): write a corrective migration; the schemas can be dropped while there's no data (`drop schema chalito, chalito_private cascade`, with Hub's go) |
| 2.4b | Notify outbox poke (migration 003050): enable pg_net (Dashboard → Database → Extensions → `pg_net`), then create the Vault secrets `select vault.create_secret('https://<notifier>/internal/notify-poke', 'chalito_notify_poke_url'); select vault.create_secret('<32 random bytes>', 'chalito_notify_poke_secret');`. Use the same secret value in Secret Manager `chalito-notify-poke-secret` (3.5) | SQL editor | after Phase 4, a test approval pushes within seconds (8.2); `select status, count(*) from chalito_private.notify_outbox group by 1` shows `sent` | `select vault.update_secret(…)`, or delete the secrets: the per-minute drain still delivers, just slower |
| 2.5 | Data API: expose `chalito`; Realtime "Allow public access" off (after checking no hub feature uses public channels) | Dashboard → API settings / Realtime settings | the Data API answers for `chalito.*` with RLS; anonymous public channels are refused | re-enable |

## Phase 3: GCP with Terraform (Ops, Owner's go) [cost]

Order: Chalyb's apply (1.10) first, then Chalito's, so `api_service_account` exists.

| # | Step | Command | Verify | Rollback |
|---|---|---|---|---|
| 3.1 | State bucket: versioned, public access prevention on | `gcloud storage buckets create gs://$PROJECT-chalito-tfstate --location=$REGION --uniform-bucket-level-access --public-access-prevention && gcloud storage buckets update gs://$PROJECT-chalito-tfstate --versioning` | `gcloud storage buckets describe …` | delete the empty bucket |
| 3.2 | Fill `infra/terraform/envs/dev/backend.hcl` and `terraform.tfvars` from the examples, including `api_service_account` (from 1.10), `hub_admin_token_secret = "chalito-admin-token"`, `supabase_url`, `vapid_public_key`, and `api_url` | edit (never commit them) | — | — |
| 3.3 | Plan | `cd infra/terraform/envs/dev && terraform init -backend-config=backend.hcl && terraform plan -out=plan.bin` | review: service accounts, Artifact Registry, Pub/Sub topics and push subscriptions, the Cloud Tasks queue, KMS keys (`prevent_destroy`), buckets, BigQuery, the budget, Cloud Run `notifier`/`orchestrator`/`mcp-gateway` (placeholder images), the avatar-jobs job, Eventarc and Workflow, the releases signer, secret containers | discard the plan |
| 3.4 | Apply [cost] | `terraform apply plan.bin` | `terraform output`; the budget alert recipients are right | `terraform destroy` (KMS keys and buckets are protected on purpose) |
| 3.5 | Put values into the secret containers created by 3.4 (OPS §5): `chalito-database-url`, `chalito-gateway-database-url`, `chalito-gateway-token`, `chalito-supabase-secret-key`, `chalito-vapid-private-key`, `chalito-openai-webhook-secret`, `chalito-voice-ref-secret`, the provider keys (Phase 5), `chalito-owner-uids` | `printf %s "<value>" \| gcloud secrets versions add <id> --data-file=-` | `packages/config/test/terraform-env.test.ts` guards the names; `gcloud secrets versions list <id>` | disable the version |
| 3.6 | Cloud Scheduler with OIDC [cost]: notifier `POST /tasks/drain-notify` and `POST /tasks/drain-usage` every minute (Terraform `schedulers.tf`, created once `notifier_public_url` is set), orchestrator `POST /tasks/sweep-decisions`, api `POST /tasks/account-deletions` hourly | `gcloud scheduler jobs create http chalito-drain-usage --schedule="* * * * *" --uri=<notifier>/tasks/drain-usage --http-method=POST --oidc-service-account-email=<scheduler sa> --oidc-token-audience=<notifier>/tasks/drain-usage --location=$REGION` (same pattern for the others) | each job's last run is 200 after Phase 4 | `gcloud scheduler jobs delete …` |

## Phase 4: Build and deploy (Ops) [cost] [visible]

| # | Step | Command | Verify | Rollback |
|---|---|---|---|---|
| 4.1 | Build and push the images (`docker/service.Dockerfile`; CI's `images` job already builds and boots each one) | `for a in api notifier orchestrator mcp-gateway; do docker build -f docker/service.Dockerfile --build-arg APP=$a -t $REGION-docker.pkg.dev/$PROJECT/chalito/$a:$(git rev-parse --short HEAD) . && docker push …; done`; avatar-jobs adds `--build-arg ENTRY=src/job.ts` | images listed in Artifact Registry | — |
| 4.2 | Deploy `notifier`, `orchestrator` and `mcp-gateway` without traffic, check, then shift (RUNBOOK §1.2) | `gcloud run deploy chalito-<svc> --image … --region $REGION --no-traffic --tag canary`, then `curl -fsS https://canary---…/healthz`, then `gcloud run services update-traffic chalito-<svc> --to-latest` | `/healthz` is `{"ok":true}` | `update-traffic --to-revisions <previous>=100` |
| 4.3 | Deploy `api` through Chalyb's engine module, with env `ACCOUNT_EXPORT_BUCKET`, `AVATAR_BUCKET`, `RECORDS_BUCKET`, `API_PUBLIC_URL`, `SCHEDULER_SA_EMAIL`, `TRUSTED_PROXIES`, `CHALYB_BASE_URL`, `SUPABASE_URL`, plus `CHALITO_RELEASES_BUCKET` and `CHALITO_RELEASES_SIGNER` from 3.4 | Chalyb's deploy | `curl -fsS https://api.chalito.chalyb.com/healthz` | previous revision |
| 4.4 | Update the avatar-jobs job image | `gcloud run jobs update chalito-avatar-jobs --image …:<sha> --region $REGION` | upload a test image under `uploads/<you>/<asset>/original`: `avatars/<you>/<asset>/card.json` appears | previous image |
| 4.5 | Domain mappings `api.chalito.chalyb.com` (Chalyb module) and `mcp.chalito.chalyb.com` [visible] | `gcloud beta run domain-mappings create --service chalito-mcp-gateway --domain mcp.chalito.chalyb.com --region $REGION` | `curl https://mcp.chalito.chalyb.com/.well-known/oauth-protected-resource` | delete the mapping |
| 4.6 | Set `notifier_public_url` and `orchestrator_public_url` to the deployed URLs, then re-apply Terraform (the env and OIDC audiences use them) | `terraform apply` | Pub/Sub push deliveries are 2xx | revert the variables |

## Phase 5: Provider accounts (Owner) [cost] [visible]

| # | Step | Where | Verify | Rollback |
|---|---|---|---|---|
| 5.1 | AI providers: Anthropic, OpenAI, xAI (optional) and Vertex (ADC) org accounts with spend limits; keys into Secret Manager [cost] | provider consoles | the orchestrator's managed turn works in Phase 8 | revoke the keys |
| 5.2 | OpenAI Realtime SIP: `realtime.call.incoming` webhook → `<notifier>/webhooks/openai`, secret into `chalito-openai-webhook-secret`; set `realtime_sip_uri` | OpenAI dashboard | the call test (8.3) connects | remove the webhook |
| 5.3 | Codex: submit the Sign in with ChatGPT partner form (D-003). Keep `owner_only` until approved | OpenAI form | approval email → flip `providers.yaml` `openai.subscriptionLocal` to `approved` | keep `owner_only` |
| 5.4 | Twilio [cost]: buy the number (0.5); Geo Permissions limited to the testers' countries; a Verify service; usage alerts and daily caps; webhooks for status, gather and SMS → notifier | Twilio console | a Verify OTP reaches your phone (`/v1/phone/start`) | release the number; disable Verify |
| 5.5 | US SMS only: A2P 10DLC registration [cost] | Twilio | approved | — |
| 5.6 | Meta / WhatsApp [visible]: Business verification, register the number on the Cloud API, a system-user token, submit the `chalito_pendientes_v1` template (ES `es_MX`, EN `en_US`, `apps/notifier/templates/`), webhook → `<notifier>/webhooks/whatsapp` with the verify token and app secret | Meta Business / WhatsApp Manager | the template is "Approved"; the webhook verification succeeds | remove the webhook; delete the template |
| 5.7 | VAPID keys for Web Push | `npx web-push generate-vapid-keys`: private key into `chalito-vapid-private-key`, public key as `vapid_public_key` | a push arrives in 8.3 | rotating invalidates subscriptions (RUNBOOK §3) |

## Phase 6: Web on Vercel (Ops) [visible]

| # | Step | Command / where | Verify | Rollback |
|---|---|---|---|---|
| 6.1 | Vercel project for `apps/web` under picassoglitch. Check that the Pro plan covers it [cost] | Vercel dashboard | the project builds | delete the project |
| 6.2 | Env (production): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable only), `NEXT_PUBLIC_CHALITO_API_BASE=https://api.chalito.chalyb.com`, `NEXT_PUBLIC_HUB_URL=https://www.chalyb.com`. Never `NEXT_PUBLIC_CHALITO_DEV_BACKEND` (the build refuses it) | `vercel env add …` | `vercel env ls production` | `vercel env rm …` |
| 6.3 | Domain `chalito.chalyb.com` → this project | Vercel domains | `curl -sI https://chalito.chalyb.com/manifest.webmanifest` is 200 | remove the domain |
| 6.4 | Deploy to production | push to the production branch, or `vercel --prod` | the landing loads; signed out, it links to the hub | `vercel rollback <previous>` |

## Phase 7: Smoke the deployed environment (Ops)

| # | Step | Command | Verify | Rollback |
|---|---|---|---|---|
| 7.1 | Read-mostly smoke against the deployment | `CHALITO_SMOKE_TARGET=staging CHALITO_SMOKE_CONFIRM=yes CHALITO_API_URL=… CHALITO_NOTIFIER_URL=… CHALITO_ORCHESTRATOR_URL=… CHALITO_MCP_URL=… SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… pnpm tsx scripts/staging-smoke.ts` (optional: `CHALITO_SMOKE_HUB_TOKEN` for the SSO round trip, `CHALITO_SMOKE_DRAIN_BEARER` for the drain dry run) | the pass/fail table is all PASS or SKIP | nothing to undo: it mints one pairing code, which expires in 5 minutes |

## Phase 8: Turn it on for the beta (Owner) [visible]

| # | Step | Command / where | Verify | Rollback |
|---|---|---|---|---|
| 8.1 | Flip the engine row to `active`, then `reconcileEngineLinks('chalito')` with a **dry run first** (CHALYB_ENGINE §9; CHALYB_HANDOFF §1 says what "off" means) | hub admin | the hub offers Chalito; launch → `chalito.chalyb.com/auth/sso` → signed in | flip back to `coming_soon` |
| 8.2 | Your own first run: sign in from the hub, enrol your phone (passkey), pair your computer (`chalito pair`), run a Claude Code session, approve from the phone (`scripts/e2e-claude.md` for the full check) | app | an approval round trip works; the audit views show the events | revoke the devices (RUNBOOK §4) |
| 8.3 | **One real call and one real WhatsApp template** [cost] [visible] (notifier README "Runbook": publish an L3 test notification, then an L4) | `gcloud pubsub topics publish notifications --message '{"v":1,"type":"notify",…}'` (exact payloads in `apps/notifier/README.md`) | push arrives; the template arrives (count, type, urgency only); "Abrir" opens the app; "Dejar de recibir" sets `whatsapp_opt_in=false`; the call speaks Spanish; 2 snoozes and 3 dismisses; `notification_sends` shows exactly one call and one template | publish the `ack … "all": true` message; re-enable the opt-in |
| 8.4 | Store: buy one paid cosmetic with your own balance [cost: hub tokens] | `/tienda` | the purchase row and `store.purchase` reach the hub, and the balance drops by exactly the price | — |
| 8.5 | Invite the testers: share the hub link. Their access comes from their hub tier; only your own ids belong in `OWNER_UIDS` (comped) | — | they sign in and pair | flip the engine row back to `coming_soon` |

## Phase 9: Desktop apps (Owner, after 8.2) [cost] [visible]

From OPS §10 (M14). Until these are done, tag builds produce **draft, unsigned** releases only.

| # | Step | Where | Verify | Rollback |
|---|---|---|---|---|
| 9.1 | Updater signing key: `pnpm --filter @chalito/desktop exec tauri signer generate -w ~/.tauri/chalito-updater.key` → secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, variable `TAURI_UPDATER_PUBKEY`. **Back it up offline**; losing it strands every installed app | GitHub repo settings | the dry run (9.4) verifies signatures with your key | — (it can't be rotated after shipping without the old key) |
| 9.2 | Apple Developer Program [cost]: Developer ID Application certificate, App Store Connect API key → `APPLE_*` secrets | Apple | the dry run notarizes | revoke the certificate |
| 9.3 | Azure Artifact Signing [cost]: account, identity validation, certificate profile, app registration → `AZURE_*` and `ARTIFACT_SIGNING_*` (decision #24) | Azure | the dry run signs the NSIS installer | delete the profile |
| 9.3b | Public app config: repository **variables** `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`; public values, never the secret key) (OPS §10.5b) | GitHub repo settings → Variables | the dry run's artifacts are named `release-<os>` (not `-unwired`) and the app can sign in | delete the variables (releases then refuse to build) |
| 9.4 | **First dry run:** Actions → Release → Run workflow | GitHub Actions | artifacts plus `latest.json`, every updater signature verified, no release created | — |
| 9.5 | First beta release [visible]: tag `v0.1.0-beta.1` → draft; check it; upload the files to `gs://$PROJECT-chalito-releases/beta/0.1.0-beta.1/` and `latest.json` to `…/beta/latest.json`; publish the draft. Never publish a draft marked "THROWAWAY test key", "UNWIRED" or "UNSIGNED" | GitHub + `gcloud storage cp` | `/descargar` offers the right file for each OS; an installed app sees the update | re-point `latest.json` to the previous version (RUNBOOK §2.4) |

## Phase 10: Before opening beyond the private beta

- [ ] Legal (`docs/LEGAL_CHECKLIST.md` "Before public launch"): privacy notice and ToS (ES/EN) published, the Developer-mode clause version matching `packages/config/legal/devmode-liability.*.md`, upload terms and a takedown channel, the automated-call disclosure, AI asset rights.
- [ ] **[cost]** The 1k-device load test against a real dev project (`docs/LOAD_TEST.md`), with results recorded.
- [ ] Codex SIWC approval (5.3) before offering ChatGPT-plan Codex to everyone.
- [ ] Decide whether a later desktop version bundles `claude` (OPS §10.7, D-061).

## Later (post-beta)

- Bundle the services to JavaScript at build time (esbuild, with the config YAMLs copied beside the bundle) and drop tsx at runtime: faster cold starts, no `/tmp` need.
- Rigged VRM avatars (D-060). Desktop panel passkey step-up (D-059). Native phone apps (decision #14).
- A static landing: the M13 pages as a route group served statically with a hash-based Content-Security-Policy (no per-request nonce), for speed and a stricter CSP.
- Hub: an Ed25519 launch token (CHALYB_HANDOFF §6.6), a `ref` on link-outs, a native `next` (§8).
- SMS for the US (10DLC) if US testers need it.
