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

## Consequences
- An endorsed client can prompt, approve and receive sealed content for exactly the computers
  its endorser trusted, with no extra pairing. Endorsing from a phone that trusts one laptop
  doesn't introduce the other.
- Trust in a computer via endorsement is weaker than a glyph scan: it rests on the endorser's
  local trust plus the directory, not on this person comparing that computer's fingerprint.
  The client UI shows "added by <endorser>" and offers the glyph check for an upgrade.
- The agent reads `chalito.endorsements`, which `member_ok` already allows. Migration 20261004002900 only adds a
  pointer broadcast to the account's agents when an endorsement is stored (`devices` inserts aren't broadcast).
