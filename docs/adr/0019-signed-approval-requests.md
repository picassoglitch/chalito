# ADR 0019: Approval requests are signed by the agent; decisions are bound to what was shown

- Status: Proposed (security review R-H1, R-M10); extends D-019 and ADR 0006
- Protocol: `v` stays 1; one new signing context, optional fields, a stricter summary.

## Context (review R-H1, R-M10)
A decision signs `{aid, requestId, uid, targetDeviceId, allow, nonce, …}`. Nothing in it
covers what the phone displayed:
- The approval row's `risk` and `step_up_required` are plaintext columns that clients trust.
- `details_ct` is sealed anonymously (`crypto_box_seal`), so anyone who knows the clients' public
  box keys (the server does) can replace it with "Read README.md" while the agent waits for an
  allow on `curl … | sh`. The passkey step-up doesn't help: it covers the decision, not the
  content.
- The summary is `toolName + JSON.slice(0, 300)` with no truncation marker, and it keeps
  bidi/format controls, so the end of a command can be hidden or reordered on screen.

## Decision
**1. The agent signs every approval request** (new signing context `chalito.approval.v1`):
- The signed body is
  `{v, aid, requestId, sid, deviceId, kind, risk, stepUpRequired, origin, createdAt, expiresAt, detailsHash}`,
  where `detailsHash = hex(SHA-256(JCS(details)))` over the exact plaintext the agent seals.
- The signature travels INSIDE the sealed payload: `detailsCt` opens to `{details, request}`
  (`request` is the signed envelope). There's no new column or migration. A replacement
  payload can't carry a valid agent signature, and an old signed payload replayed onto another
  row fails the `aid`/`requestId` match.

**2. The client verifies before showing anything as "verified".** After opening `detailsCt`,
the client checks:
- the signature against the agent's `pubSign` from its LOCAL trust (glyph-confirmed, or
  introduced per ADR 0018), never a key from the devices directory;
- that the signed `aid`, `requestId` and `deviceId` match the row;
- that `detailsHash` matches the details it opened.

Then:
- It shows the SIGNED `risk`/`stepUpRequired`, not the row's columns.
- Anything that fails is shown as "unverified" and can only be denied.
- An approval from an agent this client doesn't trust is unverified too (it can't verify the
  signature).

**3. The decision is bound to the content.**
- `DecisionBody.detailsHash` (optional in the schema for v1 compatibility) carries the
  verified hash. The passkey step-up covers it automatically, since the challenge is the body
  hash (D-019).
- The agent rejects a decision whose `detailsHash` is missing or differs from the one it
  signed (`details_mismatch`). A swapped `details_ct` therefore can never yield a usable allow.

**4. The summary is what-you-see-is-what-you-sign (R-M10).**
- One protocol helper builds it. It removes every `\p{Cf}` (format, including bidi) and C0/C1
  control character, caps it at 300 characters, and on truncation appends `… (+N chars)` and
  sets `summaryTruncated: true`.
- `ApprovalDetails.summary` REJECTS bidi/format/control characters at the schema level, so a
  hand-built summary can't slip one through.
- Clients show the full `input` and require it to be expanded before an allow when the summary
  was truncated.

## Consequences
- **Upgrade order:** agents and clients must ship together. An old client's decision (no
  `detailsHash`) is refused by a new agent, and an old agent's request has no signature, so a
  new client shows it as unverified (deny only). This is acceptable in beta.
- MCP `recommend_decision` notes remain advisory and outside the signature.
- The notifier still routes on the plaintext `risk` column; only what's shown and signed
  moved behind the signature.
