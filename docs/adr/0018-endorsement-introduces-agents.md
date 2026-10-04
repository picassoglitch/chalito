# ADR 0018: An endorsement introduces the endorser's trusted agents, in both directions

- Status: Proposed (M7 follow-up); extends ADR 0006
- Protocol: `chalito.endorsement.v1`, `v` stays 1; one optional field.

## Context
A new client (a second browser, the desktop panel) becomes trusted through an endorsement
signed by a client the person already trusts (ADR 0006, `/v1/endorse`). Two gaps remain:

1. **The new client trusts no agent.** It holds no agent box keys, so it can approve (decisions
   are verified by agents) but can't seal a prompt or command to any computer until it pairs
   with each computer's glyph again.
2. **No agent ever accepts the endorsed client.** `TrustedClientList.addEndorsed` exists in
   `@chalito/crypto`, but no agent code calls it. Endorsements are stored in
   `chalito.endorsements` and never read. So the new client's decisions are refused by every
   agent until a local re-pair, and its passkey binding is never recorded.

## Decision
**Endorsement body.** `EndorsementBody` gains an optional
`agents: [{ deviceId, pubSign, pubBox, fingerprint }]` (at most 32). These are the endorser's
locally trusted agents, introduced to the new client: only agents the endorser confirmed itself
(glyph + fingerprint), never ones it learned through another endorsement, so trust doesn't chain.
The list is part of the signed body, so
tampering with it breaks the endorsement signature. Older endorsements without the field stay
valid.

**New client (accepts agents).** After it takes the endorsement, the new client adds an agent
as trusted only when ALL of these hold:
- the endorsement verifies against the endorser's key, as published in the account's devices;
- the endorsement is for this client's exact keys (`uid`, `newDeviceId`, `pubSign`, `pubBox`);
- for each listed agent, the server's `devices` row has the same `pubSign`/`pubBox`, a
  `fingerprint` derived from `pubSign`, role `agent`, and is not revoked.

Any mismatch drops that agent. A server-side key swap for an agent therefore gets nothing
trusted: two independent sources (the endorser's signature and the devices directory) must
agree. Agents added this way are recorded as `via: "endorsement"` with the endorser's id, next to
glyph-confirmed ones. A later glyph confirmation upgrades the entry.

**Agent (accepts the client), the symmetric half.**
- The agent reads the account's endorsements when it starts, on an `endorsements` or
  `devices` pointer, after every resync, and every 15 minutes.
- For each client not in its local list, it calls `addEndorsed`. The signer must already be
  in the agent's OWN trusted list, so nothing the cloud says can add a key.
- When the endorsement carries `agents`, the agent accepts it only if it is listed there:
  the endorser chose which computers the new client may use. Without the field, the agent
  accepts it as before.
- The new client's passkey binding comes from its devices row and is verified against the
  endorsed key (`addEndorsed`'s existing check). A binding that doesn't verify rejects the
  endorsement.
- Age: the agent accepts endorsements up to 7 days old (was 24 h in the unused helper), so a
  laptop that was off over a weekend still learns the new client. Older ones need a fresh
  endorsement.

**Revocation stays final on the agent.**
- `device.revokeClient` already removes the key. The agent now also keeps a signed local
  tombstone list (in `trusted-clients.json`, under the same signature).
- An endorsement for a tombstoned or server-revoked device is never re-accepted.

**Endorser step-up (review R-L13).**
- The threat: a client that is stolen (or left unlocked) holds its device key but not its
  passkey's user verification. Without step-up, it could endorse an attacker's device, together
  with the attacker's OWN passkey binding. Every agent would record that passkey, and the attacker
  would pass HIGH/CRITICAL step-ups, bypassing D-019.
- `EndorsementBody.stepUp` (WebAuthn only) is the endorser's passkey assertion over
  SHA-256(JCS(body without stepUp)). It's the same construction as a decision step-up, so it
  binds the uid, the new keys, the agent list and the time.
- **Agent:**
  - If it recorded a passkey for the endorser (reverse check), the endorsement must carry a
    step-up that verifies against THAT passkey. Otherwise it's refused (`missing_step_up` /
    `bad_step_up`).
  - If it recorded none, it accepts the client but never records the new client's passkey
    binding. That client can approve LOW/MED but never pass a HIGH/CRITICAL step-up here, so an
    endorsement never grants more than the endorser had.
  - The new client's binding is recorded only after a verified endorser step-up.
- **Api:** `/v1/endorse/approve` verifies the same body-bound assertion against the endorser's
  stored passkey and bumps its sign counter (clone check). There is no separate server
  challenge: one ceremony.
- **Never silent:**
  - A refusal the person must act on (missing or bad step-up, bad binding, bad signature, too
    old) is logged and audited, and published as the agent's `trust.endorsement_refused` device
    event, once per client and reason.
  - The panel's Security tab (and the web) shows it: "approve it again with your passkey".
  - "Not listed" is the endorser's own choice and isn't reported.
- No local confirmation is required on the agent; the endorser's passkey is the trust root.

## Consequences
- An endorsed client can prompt, approve and receive sealed content for exactly the computers
  its endorser trusted, with no extra pairing. Endorsing from a phone that trusts one laptop
  doesn't introduce the other.
- Trust in a computer via endorsement is weaker than a glyph scan: it rests on the endorser's
  local trust plus the directory, not on this person comparing that computer's fingerprint.
  The client UI shows "added by <endorser>" and offers the glyph check for an upgrade.
- The agent reads `chalito.endorsements`, which `member_ok` already allows. Migration 20261004002900 only adds a
  pointer broadcast to the account's agents when an endorsement is stored (`devices` inserts aren't broadcast).
