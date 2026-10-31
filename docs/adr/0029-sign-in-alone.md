# ADR 0029: Sign-in alone approves a device

Status: accepted (owner decision 2026-10-19); extended by [ADR 0032](0032-sign-in-approves-everywhere.md)

## Context

Setting Chalito up on a new computer meant three approvals: the desktop panel waited for a trusted
device to endorse it ("Abre Chalito en un dispositivo de confianza…"), the computer waited for the
approval page in the browser, and the person answered the reverse check. A tester with no trusted
device left (after "Empezar de cero") was stuck, and the panel's code didn't show at all when the
endorsement watch hung.

The owner chose "sign-in alone": signing in with the Chalyb account on a device approves it, and the
desktop app connects its own computer. No second device, no email code, nothing to tap. The owner
was told the trade-off: the Chalyb password (and the hub session) becomes the only lock on the
account's devices and computers. Until now ADR 0006 held that nothing the cloud says can add a key.

## Decision

- `POST /v1/devices/signin` (`user` route): the person's own session enrols a client from its
  self-signed registration (`checkRegistration`: owner, id derived from the key, signature,
  freshness). Any number of clients, first or not. `enrolledVia: "sign_in"`, `endorsedBy: null`.
  Every device of the account gets a security notification with Devices one tap away, and it is
  audited (`device.enrolled`, `{via: "sign_in"}`).
- Agents trust the account's active `sign_in` clients from the devices directory
  (`syncSignIns`, after `syncRevocations`; `TrustedClientList.addSignedIn`, `via: "sign_in"`). The
  id must derive from the key; a client removed locally (tombstone) never comes back this way; its
  passkey binding, signed by its own key, is recorded (also when registered later).
- Clients trust the account's active computers from the directory (`accountAgents`: id derived
  from the key, fingerprint computed locally), at enrolment and on every connect.
- The desktop panel, once signed in, connects its computer itself: it starts the pairing over the
  local IPC, claims the code with the short code the agent gave it (the api counts it as typed),
  and answers the reverse check only when the approver the agent reports is the panel's own key.
  Any other approver still needs the person's "Sí, fui yo".
- The endorsement (`/v1/devices/endorsed`) stays as the fallback for an api without the route
  (removed from the desktop by ADR 0032; it remains only for a trusted device approving an older app).

## Consequences

- Anyone with the person's Chalyb session can add a device that the account's computers trust.
  Revoking a device still works (directory + agents' tombstones); the alert on every device is the
  person's signal.
- The OS password prompt before pairing (`os-auth.ts`) is unchanged: on Linux, pkexec can fail with
  no polkit agent for a process started without a terminal, which shows as "Couldn't verify it's
  you on this computer". Removing or fixing it is a separate decision (ADR 0032 removed it for the
  pairing the desktop app starts).
