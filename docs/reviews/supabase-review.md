# Supabase data layer review (ADR 0017, `supabase/`)

Reviewed `origin/supa-foundation` at 8f0a9e3 (draft PR #3):
- `docs/adr/0017-data-layer-supabase.md`
- `supabase/migrations/2026100400{01..06}00_*.sql`
- `supabase/tests/database/*.test.sql`
- `supabase/scripts/smoke-data-api.sh`
- `supabase/config.toml`

The rev columns, `session_merge` RPC and broadcast skip that -8d is adding were not on the branch yet and are not covered here.

This review is read-only; nothing was run against a Supabase project. Statements about Supabase/PostgREST/Realtime behaviour come from how those components are documented to work. Rows marked **plausible** depend on hub-side configuration I can't see from this repo (its policies, hooks and engines). The port of `firestore.rules` itself is careful: deny by default, column grants, helpers in an unexposed schema, initPlan-wrapped helpers, guard triggers for OLD/NEW comparisons, and server-time audit. The main risks sit where Chalito meets the **shared** hub project.

## Summary

| # | Severity | Area |
|---|---|---|
| S1 | Critical | Tokens are valid across Chalito and the hub in both directions (`sub`, `role: authenticated`) |
| S2 | Critical | The hub's `service_role` (held by every hub engine) bypasses all Chalito RLS and can write unsigned relays |
| S3 | High | Option A hands Chalito a key that mints any role on the hub; the `iss` fence doesn't fit Option B |
| S4 | High | `realtime.messages` policies are permissive and project-wide, so hub policies can open or spoof Chalito topics |
| S5 | High | Option C / `app_metadata`: no issuer fence; any hub service code can impersonate any device |
| S6 | Medium | Approval `decision` is a single overwritable field: any cloud-active client can clobber a valid decision |
| S7 | Medium | Shared Realtime quota: per-row broadcast fan-out lets one Chalito device starve the hub |
| S8 | Medium | Agents can attach events, approvals and call lines to another device's session (`sid` unchecked) |
| S9 | Low | Client-chosen `expires_at` / `created_at` without upper bounds (commands, events, call lines, approvals) |
| S10 | Low | Hub-wide settings the migrations need (Exposed schemas, Realtime public access, pg_cron, graphql) |
| S11 | Low | Test gaps: no test for hub-token isolation against hub policies, decision overwrite, or the realtime topic policies under a permissive hub policy |

---

## S1. Critical: Chalito and hub tokens are valid in each other's schemas

**Where:** ADR 0017 §Tokens (`role: authenticated`, `sub`, `owner`, …) and `smoke-data-api.sh:34` (`--sub smoke-user` with `owner: smoke-user`). The two schemas share one project, so they share one PostgREST, one JWT verifier and one `authenticated` role.

- **Chalito → hub:** every Chalito device token is a valid `authenticated` hub token. PostgREST switches to `authenticated` for it and evaluates the **hub's** policies on `public` (and any other exposed hub schema):
  - Hub policies keyed on `auth.uid()` give a Chalito device the hub user's rows if `sub` equals the hub user id. The smoke script mints exactly that shape, with `sub` equal to `owner`. A stolen phone token, or a compromised agent's 5-minute token, then acts as the user on the hub: billing, profile, other engines' data. That is far more than the Chalito device was trusted with.
  - Even with a distinct `sub`, any hub policy written `to authenticated using (true)`, and any `security definer` RPC in an exposed hub schema that only checks "is authenticated", is open to every Chalito device.
- **Hub → Chalito:** the `iss = 'chalito'` fence keeps hub sessions out of Chalito's tables (good, and tested in `02_identity_switch`). It only holds as long as nothing on the hub can mint or alter `iss`. A hub **custom access token hook** that copies user-editable fields into top-level claims is the classic way that breaks; check the hub for one (plausible).

**Fix:**
- **`sub`:** never use the hub user id for device tokens. Use `d_<deviceId>`, as Firebase did; for `user` web sessions use a namespaced `u_<uid>`. Make `auth.uid()` casts fail or match nothing on the hub side.
- **Hub policies:** before Chalito tokens exist, audit them for `using (true)` / `to authenticated` grants and exposed definer RPCs. Add `and coalesce(auth.jwt() ->> 'iss', '') <> 'chalito'` (or a positive hub-issuer check) to hub policies that grant on "authenticated" alone. The cleaner option is a hub-wide restrictive policy helper.
- **Tests:** add a pgTAP test in the hub repo: a Chalito-shaped token (`iss: chalito`) can read nothing in `public`.

## S2. Critical: the hub's `service_role` bypasses all Chalito RLS and can forge relays

**Where:** `20261004000200_chalito_tables.sql` (`grant all on all tables in schema chalito … to service_role`) and ADR 0017 ("The API, notifier and gateway write as `service_role`").

`service_role` has `BYPASSRLS`, and on the shared project its key is held by the hub and **every hub engine** that needs server access. Any one of them leaking its key, or being compromised, gets:
- every Chalito row;
- the ability to insert **relayed commands** (unsigned by design: `relayedBy` → `mcp:*`/`call:*` prompts) into any user's device. That is prompt injection into every paired machine.
- the ability to rewrite `devices` (revoke, un-revoke, swap `pub_sign` for the server-side fingerprint display), `pairing_codes`, and so on.

On Firebase, Chalito's Admin credentials were Chalito's alone. Here the threat model's "a cloud compromise must not equal code execution on devices" now covers **every hub engine**.

**Fix:**
- **Separate role:** don't use `service_role` for Chalito's server. Create a login role `chalito_server` with `NOBYPASSRLS` (or `BYPASSRLS` if needed). Grant it only on `chalito`/`chalito_private`, and connect the API, notifier and gateway with its own credentials (Supavisor connection string, or a JWT `role: chalito_server` if Option A/B allows minting it).
- **Revoke from `service_role`:** run `revoke all on all tables in schema chalito, chalito_private from service_role`. Privileges still apply to `service_role` even though RLS doesn't, so the hub's key can no longer touch Chalito tables. This is safe to do now.
- **Signed relays:** relays must carry a signature from a gateway/notifier key pinned on the agent at pairing (review pass 2, P2-8). On a shared project this stops being "nice to have".

## S3. High: Option A hands Chalito a key that mints any role on the hub; the `iss` fence doesn't fit Option B

**Where:** ADR 0017 §Tokens and `chalito.jwt_claims()` (`j ->> 'iss' = 'chalito'`).

- **Option A:** importing a Chalito ES256 key as the project's **current** signing key means Chalito's API can mint `role: service_role` (or `supabase_admin`-shaped claims) for the whole hub. The ADR notes this. It should be ruled out, not left as an option: it makes S2 unfixable, because whoever holds the key can mint any role.
- **Option B:** a third-party OIDC issuer is identified by a URL (e.g. `https://api.chalito.chalyb.com`), and Supabase checks `iss` against it. A token whose `iss` is the bare string `chalito` likely won't verify as that issuer, and a URL `iss` fails the fence. **Fix:** put the expected issuer in one place, for example `chalito_private.claim_issuer()` beside `claim_source()`. The fence then compares `iss` to it exactly, and pgTAP covers the URL form.
- **`aud`:** the ADR lists "whether `aud` is enforced on custom tokens" as unverified. Fence `aud = 'authenticated'` in `jwt_claims()` too, so a token minted for another audience isn't accepted.

## S4. High: `realtime.messages` policies are permissive and project-wide

**Where:** `20261004000400_chalito_realtime.sql` (`chalito_device_topic_read`, `chalito_pairing_topic_read`, "no insert policy, so clients can't send").

RLS policies on `realtime.messages` are **OR-ed** with whatever the hub has, or adds later, on the same table.

- **Read:** a hub policy like `for select to authenticated using (true)` (the Realtime quickstart shape), or one keyed on a topic pattern that also matches `device:%`, lets **any hub user** join `device:<id>` and `pairing:<code>`. Payloads are pointers, but they still leak which aids, sids and commands exist and when, and device ids are fingerprints.
- **Send:** "no insert policy" holds only until the hub adds one, for example to let its own clients broadcast. Then anyone can publish fake pointers on Chalito topics: cursor resync storms, or UI noise if a client trusts the payload.
- **Names:** `device:` is a generic topic name the hub may already use.

**Fix:**
- Prefix every topic: `chalito:device:<id>`, `chalito:pairing:<code>`.
- Add **restrictive** policies that the hub's permissive ones can't widen, for select and insert:
  ```sql
  create policy chalito_topics_guard on realtime.messages as restrictive for all to authenticated
    using (not (select realtime.topic()) like 'chalito:%' or <the chalito read checks>)
    with check (not (select realtime.topic()) like 'chalito:%');
  ```
  Non-Chalito topics are unaffected, because the first branch is true for them.
- Add a pgTAP test that creates a permissive `using (true)` hub policy and shows Chalito topics stay closed.

## S5. High: in `app_metadata` mode (Option C) there is no issuer fence

**Where:** `chalito.jwt_claims()`, the `'app_metadata'` branch.

In that mode, any token whose `app_metadata.chalito` is an object is a Chalito principal, whatever its issuer. `app_metadata` is writable by any hub code that holds the hub's `service_role` (S2), and by hub admins. So any hub engine can turn any hub user into an agent or client of any owner. Device users would also live in the hub's `auth.users`, where hub features and policies treat them as hub users (S1).

**Fix:**
- If Option C is chosen, fence it too: require `app_metadata.chalito.iss = 'chalito'` plus a signature-backed claim the hub can't produce. Better, keep device identities out of the hub's user table altogether (Option B).
- Record in ADR 0017 that Option C widens S1 and S2 to every hub admin path.

## S6. Medium: the approval `decision` is one overwritable field

**Where:** `approvals_update` + `approvals_guard` (a client may change `decision` while `status = 'pending'`, any number of times).

Decisions are only binding after the agent verifies them, so this is not an approval bypass. But **any cloud-active client of the owner** can overwrite a valid signed decision before the agent fetches it: the broadcast goes out, the agent reads the row, and by then it holds garbage. That includes a client the agent never trusted, or one revoked only locally. The agent rejects the garbage and keeps waiting, and the approval times out to deny. One misbehaving phone can deny every approval: a denial of service, and a nasty way to block a revocation.

**Fix:** use an insert-only table `approval_decisions(owner, aid, signer_device_id, decision, created_at)`, with a primary key on `(owner, aid, signer_device_id)`:
- `with check (signer_device_id = jwt_device_id())`, so one row per client;
- no update or delete for clients;
- the agent reads all rows for the aid.

It also matches the protocol better: several phones may answer.

## S7. Medium: the Realtime quota is shared with the hub

**Where:** `broadcast_change()` (a per-row trigger calling `realtime.send` once per active device) and ADR §Risks (500 messages/s and 500 connections per project on Pro).

One agent writing session events in a loop sends (events × client devices) messages. One client inserting commands in a loop generates broadcasts plus rows. Nothing limits either. A buggy or compromised Chalito device can exhaust the **hub's** Realtime quota and break Realtime for every engine.

**Fix:**
- Per-device write rate limits in the database, e.g. a `before insert` trigger with a per-device token bucket in `chalito_private`, or Supavisor/API-side limits once writes go through RPCs.
- Coalesce `session_events` broadcasts (statement-level triggers, or a "dirty" pointer per session).
- Agree a Realtime budget with the hub and alert on it.

## S8. Medium: agents can write into another device's session

**Where:** `session_events_agent_create`, `approvals_agent_create` and `call_lines_agent_create` check `owner` and `device_id = me`, but not that `sid` belongs to a session this device owns. Firestore had the same gap.

A compromised agent of the same owner can append events, approvals or call lines under another computer's session id. Phones show them in that session's timeline, inbox, and call briefing. The content is sealed by the writing agent, but the attribution is wrong.

**Fix:** add `exists (select 1 from chalito.sessions s where s.owner = … and s.sid = <row>.sid and s.device_id = jwt_device_id())` to those three policies, with pgTAP tests.

## S9. Low: client-chosen times without upper bounds

**Where:** column grants on `commands.expires_at`, `session_events.expires_at`, `call_lines.expires_at`, and `approvals.created_at` / `expires_at`.

| Field | Effect |
|---|---|
| `commands.expires_at` | A client can keep a command row (and thus its replay window, review P2-6) alive for years. |
| `call_lines.expires_at` | An agent can keep a **plaintext** call line (opt-in egress) indefinitely, against the brief's TTL. |
| `approvals.created_at` | Settable, so a "pending" approval can be dated in the future and stay pending for years within the 10-minute check. |

**Fix:** a `before insert` trigger that clamps or rejects relative to server time: `expires_at <= now() + interval '10 minutes'` for commands, `+ 30 minutes` for call lines, `+ 7 days` for events. Use a trigger, not a CHECK constraint, because CHECK expressions should be immutable and `now()` isn't. Don't grant `created_at`; let it default to `now()`.

## S10. Low: hub-wide settings the migrations rely on

These are all hub changes and need the hub owner's sign-off:
- **Exposed schemas:** `chalito` is added to `api.schemas` (`config.toml:14`). `graphql_public` is exposed too: check whether pg_graphql reflects `chalito` (it reflects the tables a role can select). Introspection would then show Chalito's schema to every hub user. If that isn't wanted, keep `chalito` out of the GraphQL endpoint.
- **Realtime:** turning off "Allow public access" breaks any hub public channel.
- **pg_cron:** `create extension pg_cron` runs as part of Chalito's migrations. Its jobs run as the migration owner (superuser-equivalent `postgres`), so a bug in `purge_expired` runs with full rights. It is fine as written (`security definer`, fixed `search_path`), but keep it minimal.

## S11. Low: tests to add before code builds on this

- A hub-token isolation test **against the hub's real policies** (S1), not only Chalito's.
- Decision overwrite by a second client (S6).
- A permissive hub `realtime.messages` policy present → Chalito topics stay closed for read and send (S4).
- Cross-session writes by a second agent (S8).
- `service_role` revoked from `chalito` tables (S2), once that's chosen.
- `aud` other than `authenticated` → no Chalito access (S3).

## Checked and fine

- Deny by default: RLS on every table, `revoke all … from public, anon, authenticated` before targeted grants, and nothing to `anon`.
- Security-definer helpers live only in the unexposed `chalito_private`, with `search_path = ''`, and `execute` revoked from `public`. Policies call them through `(select …)` initPlans.
- `device_ok()` binds device, owner, role and not-revoked on every statement. Revocation bites on the next read, matching the Firestore behaviour.
- Column grants match `hasOnly`. `approvals_guard` closes the OLD/NEW gap RLS can't express, and refuses roles other than client and agent. UPDATE policies that need it have `WITH CHECK` (`devices_self_update` pins `not revoked`; `sessions_agent_update` pins `device_id`).
- `call_lines`: the agent sees only key columns; the text is notifier-only.
- Audit: server time comes from a trigger, `meta` is capped at 8 KB, and it is insert-only.
- Pairing watch tokens see only their own live code, on both the table and the topic.
- Broadcast payloads are pointers; content is always fetched under RLS. Revoked devices are skipped by `send_to_devices`.
- Cron history cleanup is limited to `chalito-*` jobs.
