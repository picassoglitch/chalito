# ADR 0017: Data layer on the Chalyb hub's Supabase project

- Status: Proposed (owner decisions: Chalito uses the Chalyb hub's Supabase project **nexo-ai** instead of Firestore + Firebase; device credentials are **Supabase Auth users per device**, Option C in §Tokens).
- Supersedes: ADR 0002 (Firestore listeners as event bus), the Firestore parts of ADR 0006 and ADR 0016 §1 (Firebase custom tokens), and the FCM Web Push choice (D-015).
- Research: Supabase docs checked 2026-10-03 (signing keys, third-party auth, RLS, Realtime authorization/broadcast/limits, Cron, custom schemas, CLI testing).
- Code: `supabase/` (config, migrations, pgTAP tests, smoke script), CI job `supabase`.

## Context
Chalyb's hub already runs on one Supabase project; its engines integrate through the hub. Moving Chalito's data there removes a second database and a second auth system (Firebase) from the stack. Through M3, Chalito's data needs were:
- device-scoped rows with revocation that bites on the **next** read;
- signed command envelopes from a client to exactly one agent;
- approvals where a client may only attach a decision and the agent may only resolve;
- push-style delivery to devices in under 2 s;
- TTLs.

`firestore.rules` (origin/m3-agent) encoded all of this. This ADR is the port.

## Decision

### Schemas
- **`chalito`** is exposed through the Data API. Every table has RLS, and grants go only to `authenticated`, column-scoped where Firestore used `keys().hasOnly(...)` / `affectedKeys().hasOnly(...)`.
- **`chalito_private`** is **not** exposed. It holds the server-only tables (`private_recovery`, `sso_tokens`, `device_nonces`, and later purchases, subscriptions, credits, usage outbox) and every `security definer` helper. Supabase: never put a security-definer function in an exposed schema.
- Nothing is granted to `anon`. The API, notifier and gateway write as `service_role`, as the Firestore Admin SDK did.
- Tables mirror the Firestore model used so far: tenants, users, devices, endorsements, pairing_codes, commands, sessions, session_events, approvals, notifications, call_lines, audit, companions, inventory. The rest of brief §6 (mesas, rooms, records, connections, catalog, billing, …) exists as **deny-all stubs**: RLS on, no policies, no client grants. Each is annotated with the Firestore rule its milestone must port.
- Ids stay opaque text (`chalito.id` domain = the protocol's `Id`). Times are `timestamptz`. Every pushed table has `rev`, taken from one shared sequence on every insert **and update**, for resync (`cursor` is the insertion order only, so it would miss updates).

### Identity and claims
- Principals keep their Firestore shapes: `user` (web session), `client`, `agent` (devices), `pairing` (a watch token for one code). The Postgres `role` claim is always `authenticated`; Chalito's role is the `chalito_role` claim.
- `chalito.jwt_owner()`, `jwt_device_id()`, `jwt_role()` and `jwt_pairing_code()` read the claims through **one switch**, `chalito_private.claim_source()`:
  - `custom`: top-level claims, and the token must have `iss = "chalito"`. This fences out hub sessions.
  - `app_metadata`: claims under `app_metadata.chalito` (Supabase Auth users per device). `user_metadata` is never read, because users can edit it.
  Changing the switch is one `create or replace` in a new migration. pgTAP covers both modes.
- `chalito_private.device_ok()` (security definer): the token's device exists, belongs to the token's owner, has the token's role, and is not revoked. Policies call it as `(select chalito_private.device_ok())`, an initPlan evaluated once per statement. It is one probe on the unique `devices(device_id)` index.
  - **Deviation from the slice spec:** the spec named it `chalito.device_ok()`. It lives in `chalito_private` because it is security definer.

### RLS (port of firestore.rules)
| Firestore rule | Supabase |
|---|---|
| `activeDevice`: device doc exists and isn't revoked; checked every read/write | `device_ok()` in every policy; revocation is denied on the next statement |
| commands create: active client, same owner, `hasOnly([env, createdAt, expireAt, fromDeviceId])`, `ctx == chalito.command.v1`, no `relayedBy`, `fromDeviceId == me` | `commands_client_create` + column grant. Stricter: the target must be an active **agent** of the owner |
| commands read/delete: the target agent | `commands_agent_read` / `commands_agent_delete` |
| devices update: the agent itself, `onlyChanges([lastSeenAt, policyHash, devMode, status, presence, lastEvent])` | `devices_self_update` + column grant (devMode/policyHash only by the device) |
| approvals: client may change only `decision` while pending; agent only `status/resolvedAt/reason` | `approvals_update` (who) + `approvals_guard` trigger (which columns; RLS can't compare OLD and NEW) |
| audit: create-only by the agent about itself, `hasOnly([t, type, meta, source, deviceId])` | `audit_agent_create` + column grant; `t` is overwritten with server time by a trigger; `meta` capped at 8 KB |
| sessions/events: agent writes its own (`setDoc(..., {merge: true})`) | as before, plus `chalito.session_merge(sid, patch)` (security invoker) for the merge. Stricter: an agent can't rewrite a session row another device owns |
| notifications: client may change only `state/ackedAt/ackedVia` | column grant + `notifications_client_ack` |
| callLines: agent creates/deletes its own; read by the notifier only | as before. The agent can see only the **key columns** of its own lines, because Postgres applies SELECT policies to a DELETE's WHERE |
| private docs, inventory, equipping: server only | `chalito_private`, no grants; `companions` update grant excludes `equipped` |
| pairingCodes: read only by a pairing token for that code | `pairing_codes_watch`, also hidden once expired |

TTL rows (`pairing_codes`, `commands`, `session_events`, `call_lines`, `sso_tokens`, `device_nonces`) are invisible once `expires_at <= now()`. **pg_cron** deletes them in batches every minute. Chalito's own `cron.job_run_details` rows are pruned weekly.

### Realtime
- **Broadcast from the database to private per-device topics.** Supabase recommends this over Postgres Changes for scale and security.
  - AFTER triggers call `realtime.send(payload, event, 'device:<id>', private => true)` once per **non-revoked** device in the audience:
    - commands go to the target agent;
    - approvals and notifications go to every active device;
    - sessions and events go to clients;
    - device updates go to every active device, except presence-only updates (`last_seen_at`, `presence`). A device revoked by that update is not told.
  - The pairing watcher has its own `pairing:<code>` topic.
- **Payloads are pointers**: `{table, op, key, rev}`. The device fetches the row through the Data API, under RLS, so content never rides the broadcast.
- **Authorization** is RLS on `realtime.messages`: receive only on `device:<own id>` while `device_ok()`, or on `pairing:<own code>` while the code is live. There is no insert policy, so clients can't send on Chalito topics.
- **Resync:** on SUBSCRIBED, read `rev > last_rev` per table. Broadcast Replay (at most 25 messages, private channels) is only a bonus; Postgres Changes has no replay.

### Tokens (owner decided: Option C)
Device tokens stay **5 minutes** long, minted by Chalito's API after the existing Ed25519 proof of possession. Never `service_role`. Claims: `iss`, `aud: authenticated`, `role: authenticated`, `sub`, `owner`, `device_id`, `chalito_role`, `exp`, `iat`.
- **Option A (documented):** import a Chalito ES256 key as the project's **current** signing key (`supabase gen signing-key`, then standby, then Rotate).
  - Cost: the same key signs every hub session, so Chalito would hold a key that can mint any role, including `service_role`.
  - The hub must move off the legacy secret first.
- **Option B (undocumented):** register Chalito's JWKS as a third-party issuer through the Management API (`oidc_issuer_url` / `custom_jwks`).
  - Supabase never shares a key with Chalito.
  - The guides list only Clerk, Firebase, Auth0, Cognito and WorkOS, so this must be proven on a throwaway project.
  - Third-party MAU billing applies per `sub`.
- **Option C:** a Supabase Auth user per device, with claims in `app_metadata.chalito` (`claim_source() = 'app_metadata'`).
  - No key sharing.
  - Costs: an Auth user per device in the hub's user table, and refresh-token handling on devices.

The SQL supports A/B (`custom`) and C (`app_metadata`) today.

**Decision (owner):** Option C. Every device, and every pairing watcher, is a Supabase Auth user of the hub project:
- `sub` is that user's own id, never the hub uid;
- `app_metadata.chalito = {owner, device_id, role, pairing_code?}` is set only by Chalito's API through the Admin API;
- `devices.auth_user_id` / `pairing_codes.watch_auth_user_id` bind the row to that auth user.

A person's web session is their real hub account (`sub` = hub uid, no `app_metadata.chalito`), which `jwt_role()` reports as `user`. `claim_source()` defaults to `app_metadata`; `custom` remains behind the switch.

## Security review fixes
Review: `docs/reviews/supabase-review.md` (origin/supa). Migration `20261004000800_chalito_security_review.sql`, pgTAP `05_security_review.test.sql`, plus updates to suites 01–04 and both CI scripts.

| # | Fix |
|---|---|
| S1 | Device tokens never carry the hub uid. In app_metadata mode `sub` is the device's own auth user. In custom mode `sub` must be `d_<device_id>`, `u_<owner>` or `p_<code>`. The hub-side fence for hub tables is drafted in `supabase/hub/` (a Chalyb PR). |
| S2 | `revoke all` on `chalito` / `chalito_private` tables, sequences, functions and schemas from `service_role`, `anon`, `authenticated` and `public`; explicit grants only. The server uses its own role **`chalito_server`**: NOLOGIN here, with a login member created at deploy, NOBYPASSRLS, `server_all` policies, and grants matching what api/notifier/gateway do. pgTAP proves `service_role` can't read, write, or call Chalito functions. |
| S3 | `chalito_private.claim_issuer()` (custom mode, a URL for a third-party issuer) next to `claim_source()`. Every mode requires `aud = authenticated` (string or array). |
| S4 | Topics are `chalito:device:<id>` / `chalito:pairing:<code>`. A **restrictive** `chalito_topics_guard` on `realtime.messages`, for all roles and commands: non-`chalito:` topics pass through; `chalito:` topics are readable only through `realtime_topic_ok()` and never writable by clients. Tested with permissive hub-style `using (true)` read and send policies present. |
| S5 | In app_metadata mode `device_ok()` also requires `devices.auth_user_id = sub`, so the same claims on any other auth user (e.g. written by hub code) are useless. `aud` is fenced as well. Device users get no hub profile (hub draft (a)). |
| S6 | `approval_decisions`, insert-only: one row per signer per approval, while pending and unexpired, signer = caller. `approvals.decision` is dropped and clients can no longer update approvals. The agent reads every decision row for the aid and acts on the **first one whose signature verifies** against its local trusted list (ordered by `rev`). |
| S7 | Per-device token buckets for client inserts (`chalito_private.rate_limits`: capacity and refill per table). Over the limit raises SQLSTATE `PT429`, which PostgREST returns as HTTP 429. `session_events` pointers are capped at `event_broadcasts_per_second()` (10) per session; overflow marks the session dirty, and pg_cron `chalito-flush-coalesced` sends one coalesced pointer carrying the newest `rev` (a trailing burst can wait up to a minute). |
| S8 | `session_events`, `approvals` and `call_lines` inserts require the `sid` to be a session row of the writing device. |
| S9 | A `before insert` clamp for client rows: commands ≤ 10 min, call lines ≤ 30 min, events ≤ 7 days, approvals ≤ 10 min. `approvals.created_at` is server time and no longer client-grantable. |

**S7 limits: defaults for the beta, owner to review.** They live in `chalito_private.rate_limits`, so changing them is an update to that table, not a migration of the trigger:

| Table (client inserts) | Burst (capacity) | Refill per second |
|---|---|---|
| `commands` | 30 | 1 |
| `sessions` | 30 | 1 |
| `session_events` | 120 | 20 |
| `approvals` | 30 | 2 |
| `approval_decisions` | 30 | 2 |
| `call_lines` | 20 | 1 |
| `audit` | 60 | 5 |

- `session_events` broadcast cap: 10 pointers per second per session (`chalito_private.event_broadcasts_per_second()`).
- **Coalesced-flush lag:** events past the cap aren't broadcast individually. The session is marked dirty, and the next pointer for that session (any later event in a new second) covers them, because it carries the newest `rev`.
  - If the burst is the last thing a session does, the trailing pointer comes from the pg_cron job `chalito-flush-coalesced`, which runs once a minute. So clients may see the tail of a burst **up to about 1 minute late** unless they resync sooner (on reconnect, or on a `sessions` pointer when the agent updates the card).
  - Sub-minute pg_cron schedules (e.g. `'5 seconds'`) need Postgres ≥ 15.1.1.61 and a shared-project sign-off.

Also merged in this round (requested separately):
- `rev` (bumped on insert **and** update) replaces `cursor` for resync.
- `chalito.session_merge(sid, patch)` (security invoker).
- Device broadcasts skip presence-only updates.

## What changes in M2/M3 code (second slice)
- **`apps/api`:**
  - Firestore Admin calls become Postgres as **`chalito_server`** (never the hub's `service_role`, which now has no access) against `chalito` / `chalito_private`.
  - Transactions (`runTransaction`) become SQL transactions or RPCs in `chalito_private`, called with the service role.
  - `createCustomToken` becomes Admin API user management: create the device's auth user with `app_metadata.chalito`, store its id in `devices.auth_user_id`, and issue its session.
  - `ssoTokens` / `deviceNonces` use `insert … on conflict do nothing` for single use.
- **`apps/agent`:**
  - `FirestoreStore` becomes a `SupabaseStore`: supabase-js 2.117.x on Node ≥ 22, with an `accessToken` callback returning the 5-minute device JWT.
  - Listeners become a private `device:<id>` channel plus a cursor resync.
  - The `AgentStore` interface is unchanged.
- **Tests:**
  - `apps/api/test/rules.emu.test.ts` is superseded by `supabase/tests/database/*.test.sql`.
  - The `emulator` CI job and `firebase-tools` go away once the ports land.
- **Infra:** the Terraform Firestore module and the Firebase outputs are removed. The named Firestore database `chalito` is not created.
- **Web Push:** FCM becomes standard Web Push with VAPID (D-050).

## Risks
- **Shared project, shared blast radius.**
  - Option A puts the hub's signing key in Chalito's hands.
  - A wrong grant in `chalito` is exposed on the hub's API URL.
  - Mitigations: deny-by-default, column grants, nothing to `anon`, helpers in an unexposed schema, pgTAP for every rule.
- **Project-wide settings are hub changes:**
  - adding `chalito` to Exposed schemas;
  - turning off Realtime "Allow public access" (needed to enforce private channels; the hub's `postgres_changes` subscriber must be re-tested);
  - enabling `pg_cron`.
- **Realtime quotas are per project.** Pro with a spend cap allows 500 concurrent connections and 500 msgs/s, shared with the hub. Every agent and every phone holds one connection. The plan tier and spend cap are unknown.
- **Realtime revocation is not instant.** Join authorization is cached until a new token arrives or the old one expires; 5-minute tokens bound that window. Triggers stop sending to a revoked device immediately, and the Data API denies it on the next read.
- **Unverified here:**
  - `supabase start` / `supabase test db` (no Docker on the dev machine). The migrations and all pgTAP files were run on Postgres 17 with local stand-ins for `auth.jwt()`, `realtime.*` and pg_cron; CI runs the real stack.
  - Whether `supabase gen bearer-jwt --payload` keeps a custom `iss`. The smoke script fails loudly if not.
  - Whether `aud` is enforced on custom tokens.
- **pg_cron history** is pruned only for `chalito-*` jobs; the hub's history is not ours to delete.
