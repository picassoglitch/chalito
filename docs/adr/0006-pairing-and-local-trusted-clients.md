# ADR 0006: Phone-first pairing and the agent's local trusted-client list

- Status: Accepted (M0); implemented in M2/M3

## Decision
**The phone is trusted client #1.** Pairing is a two-way, key-bound ceremony.

1. **Phone enrolment.**
   - The user signs in on the PWA with Identity Platform and **2FA required** (TOTP preferred, SMS allowed; see VERIFIED_APIS §GCP).
   - The phone generates Ed25519 + X25519 keys in secure storage (ADR 0003) and registers `devices/{phoneId}` with its public keys.
   - It shows a **recovery code** (128-bit, Crockford base32). `api` stores only an Argon2id hash in `private/recovery`.
2. **Agent request.**
   - `chalito-agent` generates its keys in the OS keychain and calls `POST /pairing/codes` with its public keys.
   - `api` creates `pairingCodes/{codeId}` (TTL 5 min, single claim, short-code hash) and returns a signed `GlyphPayload` (purpose `pair_device`). The agent shows it as a **Chalito Glyph** plus `XXXX-XXXX` short code.
3. **Phone claims.**
   - The camera decodes the glyph (or the user types the short code).
   - The phone shows the device name plus the **fingerprint** derived from the payload's `issuerPubSign`.
   - The user confirms with biometric/WebAuthn, and the phone signs a claim. `api` atomically marks the code claimed and binds the device keys.
4. **Agent credential.**
   - `api` mints a Firebase **custom token** with claims `{deviceId, kind:"agent"}`.
   - Refresh uses a signed challenge (`chalito.refresh-challenge.v1`). There is no long-lived bearer secret on disk beyond the keychain keys.
5. **Reverse check (local).**
   - The desktop app (or the CLI) shows the **phone's fingerprint**. The user confirms on the desktop.
   - Only then does the agent add the phone key to `~/.chalito/trusted-clients.json`. That file is signed by the agent's key, so tampering is detected on load.
6. **More clients.**
   - A new phone or browser is accepted by an agent only with (a) an **endorsement** signed by a client already in *that agent's* list, verified locally, or (b) local confirmation on the desktop.
   - The cloud can list a device; it can't make an agent trust it.

## Revocation
- Allowed from any trusted client (signed `device.revokeClient`) or locally.
- Effects:
  - The agent removes the key immediately and rejects that key's signatures from then on, even when the server still delivers them.
  - Sessions started by that client are interrupted.
  - Recipient sets drop the key and room keys rotate.
- `api` disables the device's Firebase user, revokes its refresh tokens, and flips `revoked` (rules deny).

## Recovery (only client lost)
- Requires 2FA + recovery code + a **cool-down** (`security.recoveryCooldown`, default PT1H; owner decision #20).
- During the cool-down every device is alerted. After it, a new phone can enrol, but **each desktop must still confirm it locally**. Recovery alone can never approve anything.

## Why this order
The cloud is a relay and a directory, never a root of trust. An attacker who controls `api` can still create pairing codes, but can't get past the human fingerprint check on the phone or the local reverse check on the desktop.
