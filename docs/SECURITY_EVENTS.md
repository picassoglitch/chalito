# Security events

The catalogue of security-relevant events behind the owner-readable audit views. The views are defined in migration `supabase/migrations/20261004002400_chalito_audit_views.sql`.

## Where events live

| Store | Written by | Read by |
|---|---|---|
| `chalito.audit` | The device agent, about itself: agent audits (`source = 'agent'`) and device events (`source = 'deviceEvent'`). See `apps/agent/src/supabase-store.ts` (`audit`, `publishDeviceEvent`). Insert-only, active agent only. The server sets the time. | The owner, through RLS (`audit_read`) |
| `chalito.server_audit` | The api's audit sink, as `chalito_server`, through `PostgresAuditSink` (`apps/api/src/postgres/audit.ts`), teed with the Pub/Sub stream by `teeAudit`. Append-only; the server sets the time. | The owner, through RLS (`server_audit_read`) |
| Pub/Sub `audit` → BigQuery | Every `deps.audit.record(...)` in the api; stdout when run locally (`apps/api/src/server.ts`). | Operators only |

**Views:** all `security_invoker`, so the base tables' RLS applies and an owner sees only their own rows.

| View | Contents |
|---|---|
| `chalito.audit_trail` | Both tables. Columns: `owner, t, type, category, origin ('device' or 'server'), actor, target, meta`. |
| `chalito.audit_devices` | `audit_trail` filtered to `devices` |
| `chalito.audit_devmode` | `audit_trail` filtered to `devmode` |
| `chalito.audit_connectors` | `audit_trail` filtered to `connectors` |
| `chalito.audit_store` | `audit_trail` filtered to `store` |
| `chalito.audit_approvals` | Every non-pending row of `chalito.approvals`, as `approval.<status>` with sid, kind, risk, origin, step-up, reason and the last signer device. The sealed details and the signature are left out. Plus the `approvals` category of `audit_trail`. |

**Category:** `chalito.audit_category(type)` sets it from the type prefix:

| Category | Types |
|---|---|
| `devices` | `device.*`, `pairing.*`, `recovery.*`, `webauthn.*`, `trust.*`, `command.rejected` |
| `approvals` | `approval.*` |
| `devmode` | `devmode.*`, `policy.*`, `remote_enable.rejected` |
| `connectors` | `mcp.*`, `oauth.*`, `connector.*` |
| `store` | `store.*` |
| `channels` | `phone.*`, `channel.*` |
| `rooms` | `room.*` |
| `account` | `sso.*`, `tenant.*` |
| `other` | everything else |

**Owner-less events are BigQuery-only.** An event recorded with `owner: null` has no owner-scoped row to go in, so `PostgresAuditSink` skips it. Today that's `pairing.code_created`: the agent creates the code before it belongs to an account.

## Server events (`origin = server`)

Each is written with `deps.audit.record({ action, owner, actor, target?, meta? })`.

| Type | Category | Emitter | actor | target | meta |
|---|---|---|---|---|---|
| `device.enrolled` | devices | `apps/api/src/routes/devices.ts` (first client; endorsed) | device user uid | new device id | `{via: "first_client"}` or `{via: "endorsement", by}` |
| `device.revoked` | devices | `apps/api/src/routes/devices.ts` (`POST /v1/devices/revoke`) | uid | revoked device id | — |
| `pairing.code_created` | devices | `apps/api/src/routes/pairing.ts` | agent device id | code id | — (**owner null: BigQuery-only**) |
| `pairing.claimed` | devices | `apps/api/src/routes/pairing.ts` | uid | agent device id | — |
| `recovery.started` | devices | `apps/api/src/routes/recovery.ts` | uid | — | `{cooldownUntil}` |
| `recovery.failed` | devices | `apps/api/src/routes/recovery.ts` | uid | — | — |
| `recovery.completed` | devices | `apps/api/src/routes/recovery.ts` | uid | new device id | — |
| `webauthn.registered` | devices | `apps/api/src/routes/webauthn.ts` | uid | device id | `{credentialId}` |
| `webauthn.bound` | devices | `apps/api/src/routes/webauthn.ts` | uid | device id | `{credentialId}` |
| `webauthn.clone_suspected` | devices | `apps/api/src/routes/endorse.ts` (signature counter went backwards) | uid | endorser device id | `{credentialId, stored, reported, during}` |
| `endorse.code_created` | devices | `apps/api/src/routes/endorse.ts` | uid | new device id | — |
| `endorse.approved` | devices | `apps/api/src/routes/endorse.ts` | uid | new device id | `{by, stepUp}` |
| `mcp.grant_created` | connectors | `apps/api/src/routes/oauth.ts` (consent) | uid | connector id | `{client, provider, scopes}` |
| `mcp.grant_revoked` | connectors | `apps/api/src/routes/oauth.ts` (RFC 7009 revoke, or `POST /v1/connectors/:cid/revoke`) | client id or uid | connector id | `{via: "client" or "user"}` |
| `mcp.refresh_reuse` | connectors | `apps/api/src/routes/oauth.ts` (reused refresh token, whole grant revoked) | client id | connector id | — |
| `mcp.sharing_on`, `mcp.sharing_off` | connectors | `apps/api/src/routes/oauth.ts` (card sharing) | uid | session or device | `{scope}` |
| `mcp.recommend` | connectors | `apps/api/src/routes/oauth.ts` (`/v1/gateway/*`) | `mcp:<provider>` | approval id | `{cid}` |
| `mcp.mesa_post` | connectors | `apps/api/src/routes/oauth.ts` | `mcp:<provider>` | mesa id | `{cid}` |
| `mcp.prompt` | connectors | `apps/api/src/routes/oauth.ts` | MCP origin | session id | `{cid, command}` |
| `mcp.list_pending`, `mcp.get_session_card` | connectors | `apps/api/src/routes/oauth.ts` (`POST /v1/gateway/audit`, called by `apps/mcp-gateway/src/app.ts` for its read-only calls) | `mcp:<provider>` | session id (card) | `{cid}` |
| `store.purchase` | store | `apps/api/src/store/routes.ts` (paid purchase committed) | uid | cosmetic id | — |
| `phone.verify_started` | channels | `apps/api/src/phone/routes.ts` | uid | — | — |
| `phone.verified` | channels | `apps/api/src/phone/routes.ts` | uid | — | `{country}` |
| `phone.channels` | channels | `apps/api/src/phone/routes.ts` | uid | — | the opt-in body (whatsapp/calls/sms flags) |
| `phone.removed` | channels | `apps/api/src/phone/routes.ts` | uid | — | — |
| `room.created` | rooms | `apps/api/src/routes/rooms.ts` | uid | room id | `{type}` |
| `room.joined`, `room.left`, `room.dissolved` | rooms | `apps/api/src/routes/rooms.ts` | uid | room id | — |
| `room.key_rotated` | rooms | `apps/api/src/routes/rooms.ts` | uid | room id | `{epoch}` |
| `room.promoted` | rooms | `apps/api/src/routes/rooms.ts` | uid | room id | `{eid, rid}` |
| `room.retention_changed` | rooms | `apps/api/src/routes/rooms.ts` | uid | room id | `{from, to}` (`ephemeralTtl`, `keepPromoted`) |
| `sso.exchange` | account | `apps/api/src/routes/hub.ts` | `hub` | — | — |
| `tenant.created` | account | `apps/api/src/routes/hub.ts` | `hub` | — | `{tier}` |
| `tenant.active`, `tenant.paused` | account | `apps/api/src/routes/hub.ts` (`POST /tenants/:id/status`) | `hub` | — | — |
| `voice.session` | other | `apps/api/src/voice/routes.ts` | uid | usage source id | — |

## Device events (`origin = device`)

Written by the agent into `chalito.audit`. `actor` is the device id. Meta is redacted (`redactDeep`) before it's written.

| Type | Category | Source | Emitter | meta |
|---|---|---|---|---|
| `policy.changed` | devmode | `deviceEvent` | `apps/agent/src/daemon.ts` | `{deviceId, policyHash, t}` |
| `policy.tampered` | devmode | `deviceEvent` | `apps/agent/src/daemon.ts` (unsigned `policy.yaml` edit refused) | `{deviceId, fileHash or null, inForceHash, t}` |
| `devmode.changed` | devmode | `deviceEvent` | `apps/agent/src/devmode.ts`, `apps/agent/src/daemon.ts` | `{deviceId, on, toggles, t}` (and `by` when turned off) |
| `devmode.tampered` | devmode | `deviceEvent` | `apps/agent/src/devmode.ts`, `apps/agent/src/daemon.ts` (local files failed verification, forced off) | `{deviceId, reason: state_signature, audit_chain, stale_state, toggle_unbacked or rollback, t}` |
| `remote_enable.rejected` | devmode | `agent` and `deviceEvent` | `apps/agent/src/agent-core.ts` (a remote attempt to enable or loosen) | `{id, attempted}`; the device event adds `{origin}` |
| `policy.preset_proposed` | devmode | `agent` | `apps/agent/src/agent-core.ts` | `{preset, origin}` |
| `command.rejected` | devices | `agent` | `apps/agent/src/agent-core.ts` (invalid or refused signed command) | `{id, reason}` |
| `trust.client_removed` | devices | `agent` | `apps/agent/src/agent-core.ts` | `{clientDeviceId, by}` |
| `approval.decision_rejected` | approvals | `agent` | `apps/agent/src/approvals.ts` | `{aid, reason: invalid_signature, missing_step_up or a verify reason, signer?}` |

The DeviceEvent schemas are in `packages/protocol/src/agentEvent.ts` (`DeviceEvent`). Local Developer-mode history is also kept on the device, hash-chained (`~/.chalito/audit/devmode.jsonl`, `apps/agent/src/devmode.ts`).

## Derived approval events (`chalito.audit_approvals`)

These come from the approval rows, not from an audit write:

| Type | When |
|---|---|
| `approval.approved` | the agent verified a signed allow |
| `approval.denied` | a signed deny |
| `approval.expired` | the 10-minute TTL passed |
| `approval.rejected_invalid` | refused as invalid |

## Gaps

- **`voice.session` is `other`.** That's deliberate: it's a usage event, not a security one.
- **The notifier, orchestrator and mcp-gateway don't write to `chalito.server_audit`.**
  - The notifier logs to Cloud Logging.
  - The gateway's read-side calls reach the api through `POST /v1/gateway/audit`, so they're covered.
  - The notifier (opt-outs via WhatsApp/SMS, call acks) and the orchestrator (Mesa decisions it creates) should tee into `chalito.server_audit` with `PostgresAuditSink` (`apps/api/src/postgres/audit.ts`) when they get an audit sink.
- **`tenant.*` and `sso.exchange` may predate the user row.** `server_audit.owner` references `chalito.users`, so an event recorded before the user row exists fails its Postgres write. `teeAudit` logs it, and BigQuery still has the event.
