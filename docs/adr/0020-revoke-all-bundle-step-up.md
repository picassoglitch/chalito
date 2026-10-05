# ADR 0020: Revoke-all asks for the passkey once (a step-up over a bundle of hashes)

- Status: Proposed (beta follow-up to R-L1 and `/v1/devices/revoke-all`); extends D-019
- Protocol: `chalito.command.v1`, `v` stays 1; one optional field on `StepUp` (`bundle`).
- Migrations: none.

## Context
"Cerrar sesión en todos los demás dispositivos" revokes every other client on the server and
sends each trusted computer one signed `device.revokeClient` per other client, because agents
keep their own trust lists (ADR 0006). Revoking ANOTHER client takes the signer's passkey over
the command (R-L1), and the server takes its own server-challenged assertion. With two computers
and three other clients, that is seven passkey prompts in a row. People cancel halfway, which
leaves the server and the agents disagreeing about who is trusted.

## Decision
**One assertion covers a list of hashes, and each verifier checks that its own item is in the list.**

1. **The bundle.** The client builds every unsigned revoke command first (no `stepUp`). It then
   fetches a server challenge (`POST /v1/webauthn/assert/options`) and builds
   - `L = [h(cmd_1), …, h(cmd_n), s]` where `h(b) = hex(SHA-256(JCS(b without stepUp)))` (the
     same hash a single step-up signs), and
   - `s = hex(SHA-256(JCS({ctx: "chalito.revoke-all.v1", uid, deviceId, challenge})))`, the
     server's entry, which binds the server's single-use challenge, the account and the calling
     device.
2. **One ceremony.** The passkey signs `challenge = SHA-256(JCS({ctx: "chalito.revoke-bundle.v1", L}))`.
   The client's existing step-up provider computes exactly this when it is given `{ctx, L}` as the
   body, so no new provider is needed.
3. **Every command carries the bundle.** Each command's
   `stepUp = {method: "webauthn", at, assertion, bundle: L}` is attached, and then the command is
   signed. The server request carries the same `stepUp`.
4. **The agent** (for `device.revokeClient` of another client), when `stepUp.bundle` is present:
   - checks that `h(its own body)` is in `L` (`step_up_not_in_bundle` otherwise);
   - verifies the assertion against the signer's passkey that it recorded locally, with the bundle
     challenge;
   - enforces a **monotonic sign counter** per trusted client, stored with its trust list. The
     agent accepts a counter higher than the stored one. It also accepts the stored counter again
     only for the same bundle (several commands from one bundle reach the same computer).
     Anything else is `step_up_replayed`. A withheld command from an old bundle is therefore
     refused once that passkey has signed anything newer for this computer.
   - Authenticators that always report 0 (many synced passkeys) can't be ordered this way. For
     them, replay is still bounded by each command's own nonce and its 10-minute expiry, both
     inside the hash in `L`.
5. **The server** (`/v1/devices/revoke-all`) takes its single-use challenge, recomputes `s` and
   requires it in `L`, then verifies the same assertion with the bundle challenge. It also
   requires user verification and bumps the stored counter atomically, as in `verifyStepUp`. It
   then queues only commands whose `stepUp.bundle` equals `L` and whose own hash is in `L`.
6. **Single revokes are unchanged.** `revokeClient` keeps its per-command step-up (no `bundle`),
   and agents record its counter too. A bundle is accepted only on `device.revokeClient`, and
   decisions never accept one.

## Consequences
- **One prompt for N commands.** The person sees one passkey prompt for the whole revoke-all.
- **What one assertion authorizes.** A single assertion now authorizes up to 500 revokes. They
  are still only revokes of this account's clients, signed by this device, each bound in `L`.
  The bundle can't be stretched to any other command type.
- **Upgrade order.** Agents and the api must ship before clients that send bundles. An old agent
  doesn't know `bundle` and rejects the assertion as `wrong_challenge`, which fails safe (the
  server still revokes, and the person repeats the revoke for that computer later).
  `ClientActions.revokeAll` no longer uses its `stepUp` option; the option is kept and ignored,
  so the web build doesn't break.
- **Changes to the trust file.** `TrustedClient.signCount` and `signBundle` are new optional
  fields in the agent's signed trust file. Older files load as "no counter seen yet".
