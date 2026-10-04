# ADR 0002: Firestore listeners as the realtime event bus (no WebSocket gateway)

- Status: **Superseded by [ADR 0017](0017-data-layer-supabase.md)** (Firestore cut-over). Realtime is now Supabase Broadcast from the database to private `chalito:device:<id>` topics, with pointer payloads and `rev` resync. Kept for history.
- Originally: Accepted (M0)

## Context
Agents, phones, desktops and rooms need sub-2-second fan-out. Options:
- **(a)** A self-hosted WebSocket gateway on Cloud Run (long-lived connections, sticky sessions, paying for idle instances).
- **(b)** Firestore realtime listeners. Firestore is already our only database.
- **(c)** Polling. Forbidden by the brief.

## Decision
- **Firestore snapshot listeners are the client-facing bus.**
  - Device agents authenticate with a Firebase custom token (minted by `api` after pairing) and listen on `users/{uid}/devices/{deviceId}/commands` (M2 detail).
  - Clients listen on `approvals`, `sessions`, `notifications` and the rooms they belong to.
- **Pub/Sub is the server-side bus.** Topics: `agent-events`, `notifications`, `room-events` (one topic with attributes, not one per room), `billing-events`, `usage`, `audit`, each with a DLQ. Pub/Sub pushes to Cloud Run with OIDC auth.
- **Cloud Tasks handles time.** Escalation ladder steps, snoozes, reminders and approval-expiry notices.
- Cloud Run services keep **min instances 0** with request-based billing. No service holds client connections.

## Why
- No connection fleet to run or pay for; listeners survive Cloud Run scale-to-zero.
- Security rules gate every listener per document, which matches our per-user/per-room access model.
- Offline clients get missed docs on reconnect. Missed push events are recovered from Firestore state, not from a replay log.

## Consequences / risks
- **Listener read costs.** Every changed doc delivered to a listener is a billed read. Mitigation: typed, coalesced events; Session Cards instead of transcripts; addressed fan-out (`to[]`); TTL on events. Load test in M15.
- **Firestore TTL deletes lazily** (verified in VERIFIED_APIS: typically within 24 h, not guaranteed). Clients must filter `expireAt < now` themselves.
- **Ordering.** Per-session `seq` on AgentEvents lets clients detect gaps and resync from the card.
- **Revocation.** Revoking a device disables its Firebase user / revokes refresh tokens and flips `revoked` (rules deny), so listeners error out on the next token refresh (≤1 h). For instant cut-off, rules also check a `revoked` flag on the device doc, which applies immediately to new reads (M2 test: "revocation blocks the agent's next read").
