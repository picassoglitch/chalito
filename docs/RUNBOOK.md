# Runbook

Procedures for running Chalito in production. Every command assumes the Chalyb GCP project (`PROJECT`) and region `us-central1`. Anything marked **not yet built** is a gap, not a procedure.

**Where things run:**
- Chalito's Cloud Run services and the notifier's webhooks live in Chalyb's GCP project (ADR 0016). The api is deployed by Chalyb's engine module.
- The web app is on Vercel (`chalito.chalyb.com`).
- Data is in the hub's Supabase (ADR 0017), in schemas `chalito` and `chalito_private`.

**Owner's go required:**
- Deploys to production.
- Key rotations of shared secrets.
- Anything in `docs/OPS.md`.

## Contents

1. [Deploy](#1-deploy)
2. [Roll back](#2-roll-back)
3. [Rotate keys](#3-rotate-keys)
4. [Revoke a device, or every device](#4-revoke-a-device-or-every-device)
5. [Lost phone, lost laptop, only-client recovery](#5-lost-phone-lost-laptop-only-client-recovery)
6. [Incidents](#6-incidents)

## Services

| Service | Where | Defined in | Notes |
|---|---|---|---|
| `api` | Cloud Run | Chalyb's engine module (not in this repo's Terraform) | Public. Hub contract, devices, pairing, recovery, phone, voice, store, OAuth for MCP (`apps/api/src/routes/oauth.ts`), WebAuthn, endorse, rooms. |
| `chalito-notifier` | Cloud Run | `infra/terraform/envs/dev/main.tf` (`module "notifier"`) | Pub/Sub push, Cloud Tasks, Twilio/Meta webhooks. See `apps/notifier/README.md`. |
| `chalito-orchestrator` | Cloud Run | `module "orchestrator"` | Mesa and companion turns. See `apps/orchestrator/README.md`. |
| `chalito-mcp-gateway` | Cloud Run | `module "mcp_gateway"` | Public by design (ADR 0009). See `apps/mcp-gateway/README.md`. |
| `avatar-jobs` | Cloud Run **job** | not yet in Terraform | One upload per execution (`AVATAR_BUCKET`, `UPLOAD_PATH`); custom companions also need `GEMINI_API_KEY` and `DATABASE_URL`, and a 600 s timeout. See `apps/avatar-jobs/README.md`. |
| web | Vercel | Vercel project (`apps/web`) | PWA. |
| database | hub Supabase | `supabase/migrations/` | Migrations are forward-only. |

---

## 1. Deploy

### 1.1 Database migrations (first, always)

Migrations are **forward-only and additive**. A deploy never depends on a migration that hasn't been applied, and old code must keep working on the new schema.

1. Check the migrations against a fresh database in CI. The `supabase` job runs `supabase db reset` plus `supabase test db`.
2. Apply them to the hub database. Migrations belong to the session or owner that owns `supabase/migrations`.
   ```sh
   supabase link --project-ref <hub-project-ref>
   supabase db push
   ```
   Chalito's migrations are prefixed `20261004…` and touch only `chalito` and `chalito_private`.
3. Confirm:
   ```sh
   supabase migration list
   ```
   Every local version should show as applied remotely.

### 1.2 Cloud Run services

Images go to the Artifact Registry repo created by `module "artifact_registry"`.

1. Build and push, from the repo root. There's one Dockerfile for every service: distroless Node, non-root, base images pinned by digest, no transform cache so the root filesystem can be read-only. CI builds every image and boots each one read-only on every PR (job `images`), but never pushes.
   ```sh
   docker build -f docker/service.Dockerfile --build-arg APP=<api|notifier|orchestrator|mcp-gateway> \
     -t us-central1-docker.pkg.dev/$PROJECT/chalito/<service>:$(git rev-parse --short HEAD) .
   docker push us-central1-docker.pkg.dev/$PROJECT/chalito/<service>:$(git rev-parse --short HEAD)
   ```
   For avatar-jobs, add `--build-arg ENTRY=src/job.ts`. **Filesystem:** the images run with a read-only root; `/tmp` is the only writable path (tsx makes a temp dir there). Cloud Run's in-memory `/tmp` covers it; anywhere else, run with `--read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m`. To bump a base image, update its `@sha256:` digest in `docker/service.Dockerfile`.
2. Deploy without traffic, then check the new revision:
   ```sh
   gcloud run deploy chalito-<service> --image …:<sha> --region us-central1 --no-traffic --tag canary
   curl -fsS https://canary---chalito-<service>-<hash>-uc.a.run.app/healthz
   ```
3. Shift traffic:
   ```sh
   gcloud run services update-traffic chalito-<service> --to-tags canary=10
   ```
   Watch errors (Cloud Logging, `severity>=ERROR`) for 10 minutes, then:
   ```sh
   gcloud run services update-traffic chalito-<service> --to-latest
   ```
4. **`api` is Chalyb's engine module.** It deploys through Chalyb's pipeline with the same tag-then-shift steps.
5. Terraform-managed settings (env, secrets, invokers) change only through:
   ```sh
   cd infra/terraform/envs/dev && terraform plan
   ```
   Then `terraform apply`, **with the owner's go** (see `infra/terraform/envs/dev/README.md`).

### 1.3 avatar-jobs (Cloud Run job)

1. Create the job once:
   ```sh
   gcloud run jobs create chalito-avatar-jobs --image …:<sha> --region us-central1 \
     --set-env-vars AVATAR_BUCKET=<bucket> --service-account <sa> --max-retries 1 --task-timeout 120s
   ```
2. Update it:
   ```sh
   gcloud run jobs update chalito-avatar-jobs --image …:<sha>
   ```
3. **`GEMINI_API_KEY` must come from a paid-tier AI Studio project** (billing enabled), so user photos aren't used to train Google's models (Gemini API terms: only unpaid-service content is used to improve products). Before the first deploy and after every key change, open AI Studio → API keys and check that the key's project shows a paid tier. If it doesn't, don't deploy the key, and keep custom companions off on the api too (no `AVATAR_BUCKET` on the api): **don't just unset `GEMINI_API_KEY`**, because without it the job treats an upload as a plain image card (`processUpload`), not a creation.
4. Each upload runs it automatically (`infra/terraform/envs/dev/avatar_jobs.tf`): GCS object finalized in the assets bucket → Eventarc → Workflow `chalito-avatar-upload`, which runs the job with `UPLOAD_PATH` set for `uploads/<owner>/<asset>/original` objects only. By hand:
   ```sh
   gcloud run jobs execute chalito-avatar-jobs --update-env-vars UPLOAD_PATH=uploads/<owner>/<asset>/original
   ```

### 1.4 Web (Vercel)

1. Push to a branch for a preview deployment, and check the preview.
2. Promote:
   ```sh
   vercel promote <preview-url> --scope <team>
   ```
   Production is `chalito.chalyb.com`.

### 1.5 Scheduled jobs

| Job | Target | Signer |
|---|---|---|
| Usage outbox drain, every minute | `POST <notifier>/tasks/drain-usage` | Cloud Scheduler OIDC as `SCHEDULER_SA_EMAIL` |
| Purges (voice call refs, sent outbox rows, TTLs) | `pg_cron` in the database (migrations 000500, 001500, 001600) | — |

---

## 2. Roll back

### 2.1 A Cloud Run service

1. List revisions:
   ```sh
   gcloud run revisions list --service chalito-<service> --region us-central1
   ```
2. Send all traffic to the last good one:
   ```sh
   gcloud run services update-traffic chalito-<service> --to-revisions <good-revision>=100
   ```
3. Confirm `/healthz` and the error rate. Then open an issue with the bad revision's SHA.

### 2.2 Web

1. Promote the previous production deployment:
   ```sh
   vercel rollback <previous-deployment-url>
   ```
   Or use the Vercel dashboard: Deployments → … → Promote.

### 2.3 Database

**Migrations are never rolled back.**

1. Write a new forward migration that undoes the change, with the next free number (ask the migration owner).
2. Roll the code back first (2.1/2.2). Old code must work on the new schema, which is why migrations are additive.
3. If data was damaged, restore from Supabase point-in-time recovery into a **new** project and copy back the affected rows. This needs the owner's go, and it's the hub's database.

### 2.4 Desktop app release

The updater only moves forward (`docs/THREAT_MODEL.md`). To pull a bad release:
1. Unpublish the GitHub draft or release.
2. Re-point `latest.json` in the private bucket to the previous version, signed with the updater key.
3. Raise the minimum supported version in the api once a fixed release exists.

The signed-updater release pipeline is M14 and is **not yet built** (`apps/desktop` has no updater config yet).

---

## 3. Rotate keys

General steps for a secret in Secret Manager (`module "secrets"`):

1. Add a new version:
   ```sh
   printf %s "$NEW" | gcloud secrets versions add <secret> --data-file=-
   ```
2. Roll the services that read it, so they pick up `latest`:
   ```sh
   gcloud run services update chalito-<service> --region us-central1 --update-labels rotated=$(date +%s)
   ```
3. Confirm the services work. Then disable the old version:
   ```sh
   gcloud secrets versions disable <old-version> --secret <secret>
   ```

| Secret | Holder | Notes |
|---|---|---|
| `CHALITO_SSO_SECRET` | Chalyb engine module (api) and the hub | Shared HMAC with the hub. **Coordinate with Chalyb:** the hub must sign with the new value at the same moment. Accepting two secrets during rotation is **not yet built**, so expect a few seconds of failed SSO launches; users retry. |
| `CHALITO_ADMIN_TOKEN` | Chalyb engine module (api, notifier) | The hub's bearer for `/hub/tenants*` and Chalito's bearer for `/api/engines/chalito/*`. Rotate on the hub and in Secret Manager together. Usage reports fail with 401 in between; those are permanent (`dead`) in the outbox. Afterwards, re-queue the dead rows (6.2 step 5). |
| `VOICE_TOKEN_SECRET` | api | Signs voice heartbeat tokens. Rotating it ends live desktop voice sessions at their next heartbeat (403), and the desktop reconnects. |
| Twilio (`chalito-twilio-auth-token`, `-account-sid`, `-verify-service`) | notifier, api | Create a secondary auth token in the Twilio console, deploy it, then promote it. Webhook signatures use the primary token, so promote only after the deploy. |
| Meta (`chalito-meta-wa-access-token`, `-app-secret`, `-verify-token`) | notifier, api | System-user token from Business Settings. Rotating the app secret changes `X-Hub-Signature-256`, so deploy first, then reset in the Meta app dashboard. |
| VAPID (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`) | notifier | Rotating invalidates every push subscription, and clients re-subscribe on next open. Avoid unless compromised. |
| OpenAI / Anthropic / xAI keys | orchestrator, notifier, api | Create a new key in the provider console, deploy it, then revoke the old one. |
| Supabase secret key (`SUPABASE_SECRET_KEY`) | api | It's the hub's project. Create a new secret key in Supabase (API keys), deploy, then delete the old one. Coordinate with Chalyb, who may share the project. |
| Database login (`DATABASE_URL`) | api, notifier, orchestrator | Rotate the password of the login that holds `chalito_server` (or `chalito_gateway`). Deploy the new URL, then expire the old password. |
| `GEMINI_API_KEY` (`chalito-gemini-api-key`) | avatar-jobs | Create the new key **in the same paid-tier AI Studio project** (1.3 step 3), deploy, then delete the old one. |
| `AVATAR_FREE_MARKER_KEY` | api | **Don't rotate** unless it leaked: the markers in `chalito_private.avatar_free_markers` are keyed by it, so a new key forgets who used their free custom companion (each person could get one more free creation). If it leaked, rotate and accept that. |
| Updater signing key | GitHub Actions secret only | Rotating means shipping a release whose embedded public key is the new one, signed by the **old** key. Do it before the old key is lost. M14, **not yet built**. |

---

## 4. Revoke a device, or every device

### 4.1 One device

1. From an active client (phone or web), Ajustes → Dispositivos → Quitar. This calls `POST /v1/devices/revoke` (`apps/api/src/routes/devices.ts`). It:
   - sets `chalito.devices.revoked` (the next request from that device gets `403 device_revoked`, checked in `requireAuth`);
   - bans the device's Supabase Auth user (`SupabaseIssuer.disableDevice`, `ban_duration` forever);
   - writes `device.revoked` to the audit log (`chalito.audit_devices`).
2. A revoked agent stops itself on its next call (`apps/agent/src/daemon.ts`, `device_revoked`).
3. Without a client: an operator runs the same with `service_role` in the SQL editor, **on the owner's request only**:
   ```sql
   update chalito.devices set revoked = true, revoked_at = now() where owner = '<owner>' and device_id = '<id>';
   ```
   Then ban the auth user in Supabase Auth (Users → the `device:<id>` user → Ban).

### 4.2 Every other client (revoke-all)

`POST /v1/devices/revoke-all` (`apps/api/src/routes/devices.ts`), from a trusted client **with a passkey step-up** (mandatory):
- revokes every other client in one statement and bans each one's Auth user, so RLS and `requireAuth` cut them off at once;
- queues the caller's signed `device.revokeClient` commands, one per (agent, revoked client). The server checks the signer, the signature, that the target is one of the owner's agents, and that the client isn't the caller; agents then drop the revoked clients from their trust lists. The server can't sign these itself;
- audits `device.revoked` for each client and `device.revoked_all`. A failed ban is listed in `banFailed` and logged; the revoked flag still applies.

Agents stay paired: revoke them one by one (4.1) if needed.

**Without any trusted client** (all lost), on a verified request from the owner:
1. Use recovery (5.3) to get a client back, then run revoke-all from it.
2. Or, as an operator:
   ```sql
   update chalito.devices set revoked = true, revoked_at = now() where owner = '<owner>' and not revoked;
   ```
   Then ban each device's Auth user (`chalitoAuthUserId("device", <id>)`, `apps/api/src/supabase/identity.ts`).
3. Revoke MCP connectors: `POST /v1/connectors/:cid/revoke` for each grant (`apps/api/src/routes/oauth.ts`).

## 5. Lost phone, lost laptop, only-client recovery

### 5.1 Lost laptop or desktop (an agent)

1. From the phone, revoke the device (4.1). Pending approvals for its sessions stop being answerable: the agent is gone, and decisions bind to `targetDeviceId`.
2. If Developer mode was on there, nothing remote can re-enable it (ADR 0006). Revocation is enough.
3. The local `~/.chalito` keys on the lost machine are useless once revoked. The api refuses the device and the auth user is banned.

### 5.2 Lost phone, another client exists (web, second phone)

1. From the other client, revoke the lost phone (4.1).
2. Enroll the replacement as an endorsed device (`POST /v1/devices/endorsed`, approved from the remaining client; `apps/api/src/routes/endorse.ts` covers the endorsement flow).

### 5.3 Lost phone, it was the only client

Recovery code + cool-down, `apps/api/src/routes/recovery.ts` (ADR 0006):

1. The owner signs in on the hub (role `user`) on the new phone and enters the recovery code. That's `POST /v1/recovery/start`, rate-limited to 5 per IP, refilling one a minute.
2. Every device gets an L3 security notification (`security:recovery`), and the cool-down starts (`RECOVERY_COOLDOWN_MS`, default 1 h, decision #20).
3. After the cool-down, `POST /v1/recovery/complete` enrolls the new phone with `enrolledVia="recovery"`.
4. Each agent must confirm the new client locally before it can approve anything.
5. Revoke the lost phone (4.1) from the new one.
6. If the recovery wasn't the owner (the alert arrived unexpectedly): from any device, revoke the recovering phone, then follow 6.1.

Wrong codes are audited as `recovery.failed`.

---

## 6. Incidents

First steps for every incident:
1. Open an incident note with the time and who's on it.
2. Check Cloud Logging and Error Reporting for the affected service.
3. Post status where the owner sees it.
4. Afterwards, write up the cause and follow-ups.

### 6.1 Suspected account compromise

1. Read the owner's audit trail with service_role, or have the owner open the audit views (`chalito.audit_trail`, `audit_devices`, `audit_approvals`, `audit_devmode`, `audit_connectors`):
   ```sql
   select t, type, category, origin, actor, target from chalito.audit_trail where owner = '<owner>' order by t desc limit 200;
   ```
   Look for:
   - `device.enrolled`, `recovery.started`, `pairing.claimed`, `webauthn.*` you don't recognize;
   - `mcp.grant_created`;
   - `devmode.changed`, `devmode.tampered`, `policy.tampered`.
2. Revoke every unknown device (4.1), or all of them (4.2).
3. Revoke every MCP connector.
4. Ask the owner to:
   - change their hub password and sign out other sessions on Chalyb;
   - regenerate the recovery code.
5. Check for approvals decided in the window (`chalito.audit_approvals`). HIGH and CRITICAL ones needed a passkey step-up.
6. If a server secret may be exposed, rotate it (section 3).
7. Keep the BigQuery `audit` dataset rows for the window. They are the full server-side record, including owner-less events such as `pairing.code_created`.

### 6.2 Chalyb hub outage

**What happens on its own:**
- **Managed work fails closed.** `admit` throws `HubUnavailable`, and `admitManaged` (packages/billing, "Out of energy") answers on `free_min`, without the recharge line. No managed spend happens without an admission.
- **Approvals, sessions, BYO and safety keep working.** They never call the hub.
- **SSO launches from the hub fail** (the hub is down). Devices already signed in keep working.
- **Store purchases return `503 hub_unavailable`.** Nothing is charged or granted.
- **Usage events wait in `chalito_private.usage_outbox`.** The drainer retries with backoff (30 s → 1 h).

**Steps:**
1. Confirm it's the hub:
   ```sh
   curl -sS -o /dev/null -w '%{http_code}' https://www.chalyb.com/api/engines/chalito/usage/balance?external_user_id=x -H "authorization: Bearer $CHALITO_ADMIN_TOKEN"
   ```
   A 5xx or a timeout means the hub is down.
2. Tell Chalyb (the hub is their service). No Chalito action is needed to stay safe.
3. Watch the outbox:
   ```sql
   select status, count(*) from chalito_private.usage_outbox group by 1;
   ```
4. After recovery, `pending` drains within minutes. Check alerts for `billing.usage_dead` and `billing.usage_invalid`.
5. Dead rows from 401/4xx during the outage, for example a token mismatch, are kept, never dropped. Re-queue them after fixing the cause:
   ```sql
   update chalito_private.usage_outbox set status = 'pending', next_attempt_at = now() where status = 'dead' and <condition>;
   ```
   The hub rejects `occurred_at` older than 7 days, so events stuck longer than that stay dead. Settle them with Chalyb by hand.

### 6.3 Payment webhook outage

Payments, the trial and refunds are the **hub's** (Mercado Pago, ADR 0012/0016). Chalito never receives payment webhooks.

1. Report it to Chalyb. Their runbook covers Mercado Pago.
2. Chalito's effect: a user's tier or balance may lag. Entitlements follow the hub, so managed features may sit on `free_min` until it catches up. BYO and safety are unaffected.
3. Nothing to replay on Chalito's side.

### 6.4 Twilio or Meta outage

1. Check status.twilio.com and metastatus.com. Twilio failures show in the notifier logs and in `chalito_private.notification_sends`.
2. **The ladder degrades on its own.** Push and desktop rungs don't depend on Twilio or Meta, and a failed rung moves on.
3. Phone verification (`/v1/phone`, Twilio Verify) fails during the outage. Tell users to retry later; nothing needs undoing.
4. If WhatsApp sends fail with template errors, not an outage, check the template status in WhatsApp Manager (`chalito_pendientes_v1`).
5. Webhook signature failures after a credential change mean section 3 was done out of order: redeploy the notifier with the current secret.

### 6.5 Room abuse report

Rooms: `apps/api/src/routes/rooms.ts`, mounted at `/v1/rooms`. Members can only post typed data events (THREAT_MODEL, "Malicious member").

1. A report button is **not yet built**. Reports arrive through support for now.
2. Identify the room and the offending companion from the report, and preserve evidence with service_role:
   ```sql
   select * from chalito.room_events where room_id = '<id>';
   ```
   The content is end-to-end encrypted, so you see metadata only.
3. The room owner can dissolve the room (`POST /v1/rooms/:roomId/dissolve`, audited as `room.dissolved`) or rotate the key (`POST /v1/rooms/:roomId/rotate`). Members can leave (`POST /v1/rooms/:roomId/leave`). The owner can remove a member (`POST /v1/rooms/:roomId/members/:companionId/remove`, audited as `room.member_removed`); like a leave, the room then needs a key rotation before anyone posts again.
4. For abuse across rooms, revoke the offender's devices (4.2) on legal advice. For uploaded images, follow the takedown in `docs/LEGAL_CHECKLIST.md`.
5. Room events expire under the retention policy (24 h by default, decision #12).

### 6.6 Account deletion (ARCO / erasure requests)

`/v1/account` (`apps/api/src/account/routes.ts`, migration `20261004003030`):
1. **The owner asks** from a trusted client with a passkey step-up: `POST /v1/account/deletion`.
   - An export of everything Chalito holds is written first: `chalito_private.export_account`, no secrets, stored under `exports/<owner>/` in `ACCOUNT_EXPORT_BUCKET`. The owner downloads it with `GET /v1/account/export`.
   - Every device gets an L3 security notification.
   - The deletion is due in 7 days.
2. **The owner can cancel** until then: `DELETE /v1/account/deletion`, from any of their sessions.
3. **When due**, Cloud Scheduler calls `POST /tasks/account-deletions` (OIDC as `SCHEDULER_SA_EMAIL`, hourly):
   - deletes the device Auth users;
   - deletes the owner's prefixes: `avatars/` and `uploads/` in `AVATAR_BUCKET`, `records/` in `RECORDS_BUCKET`, `exports/`, every object version included (nothing stays in the buckets' 30-day noncurrent-version window);
   - runs `chalito_private.delete_account`: everything cascades from `chalito.users`, plus the legacy credit tables and sent usage. Unsent usage stays until the drainer reports it.
   - Each step is idempotent: a failed owner is retried on the next run.
4. **Not touched:** the hub account, its balance and payments (Chalyb's). Point the person to Chalyb for those.
   - **Kept on purpose:** `chalito_private.avatar_free_markers` (migration `20261005000200`). Each row is only a keyed hash (HMAC-SHA256 under `AVATAR_FREE_MARKER_KEY`) of the hub user id or the lowercased email of someone who used their free custom companion, with no owner column and no link to anything else. It survives deletion so that deleting the account and signing up again doesn't give a second free creation. It's disclosed in the privacy text (draft: `packages/config/legal/drafts/custom-companion.*.md`). If counsel decides a person can ask for it to go too, delete the two markers computed with `freeMarkers()` (`apps/api/src/avatar/free-marker.ts`) from their hub user id and email.
5. **For an operator-run request** (e.g. by email, identity checked): schedule it with `insert into chalito_private.account_deletions …`, or ask the owner to use the app. The 20-business-day ARCO clock covers the 7-day grace.

### 6.7 Release rollback

1. Services: 2.1.
2. Web: 2.2.
3. Desktop: 2.4.
4. If the release came with a migration, leave the migration in place. It's additive. Roll the code back only.
5. Note the bad SHA in the incident write-up. Re-release with a fix through the normal deploy (section 1).

### 6.8 A person deletes their custom companion ("Eliminar mi personaje")

`DELETE /v1/avatar/creations/:id` (`apps/api/src/avatar/routes.ts`, migration `20261005000400`), from "Tus personajes" under "Crea tu personaje" (Settings, after an in-page confirmation). Owner only; idempotent.
1. **Refused while that creation is in flight** (`409 in_flight`: awaiting upload, queued or generating). The person waits for it to finish (a stuck one times out on its own, then there's nothing to delete). Failed or expired creations never kept drawings (`409 not_deletable`).
2. **The row first:** `succeeded → deleted`, `deleted_at` set, `manifest` dropped (trigger `avatar_creation_status_guard`; `deleted` is never left). In the same transaction a companion wearing it gets `asset_id`/`expression_map` cleared (trigger `avatar_creation_deleted`), so it's drawn from its roster avatar again. From then on no one is handed the card: `GET /companion`, `GET /creations`, `GET /rooms/:roomId/cards` and `POST /use` all skip or refuse it. Signed URLs already handed out stop working once the files are gone; rooms (15-minute URLs) and the desktop pet (5-minute check) refresh and fall back to the roster avatar by themselves.
3. **Then the bucket:** every object under `avatars/<owner>/<asset_id>/` and `uploads/<owner>/<asset_id>/`, **every generation** (listed with `versions: true`, each generation deleted explicitly), so nothing stays in the bucket's 30-day noncurrent-version window. Then `files_deleted_at` is set. If the bucket step fails the api answers `503 retry` and the person's retry finishes it.
4. **Nothing is given back.** The row stays for billing and audit (cost, attestation, reservation). A paid creation stays billed (its reservation settles as `succeeded`, even if settled after the deletion). A deleted free creation still holds the free credit (`avatar_creations_one_free` includes `deleted`) and `chalito_private.avatar_free_markers` isn't touched.
5. **Leftovers** (a deletion whose bucket step never finished, e.g. the person never retried):
   ```sql
   select owner, asset_id, deleted_at from chalito.avatar_creations
   where status = 'deleted' and files_deleted_at is null;
   ```
   For each, delete every version under the prefix (`gcloud storage rm --all-versions "gs://$AVATAR_BUCKET/avatars/<owner>/<asset_id>/**"`), then `update chalito.avatar_creations set files_deleted_at = now() where asset_id = '<asset_id>'`.
6. **Operator-run request** (e.g. a parent writes in, identity checked): the same as above by hand. Mark the row deleted first (`update chalito.avatar_creations set status = 'deleted' where creation_id = '…' and status = 'succeeded'`; the triggers do the rest), then delete the files as in step 5.
