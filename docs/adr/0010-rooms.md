# ADR 0010: Rooms and companion-to-companion messaging

- Status: Accepted (M0); implemented in M11 on Supabase (see the update below, D-058)

## Decisions
- **Data:** `rooms/{roomId}`, `roomMembers/{companionId}`, `roomEvents/{eid}` (one events subcollection per room), and `roomInvites/{inviteId}`. Schemas live in `packages/protocol/src/room.ts`.
- **Fan-out:**
  - Online members get events through **Firestore listeners** on their rooms' `roomEvents`.
  - Offline addressed members get a metadata-only push: `api` publishes to the single Pub/Sub topic `room-events` (attributes roomId, kind, urgency), and `notifier` sends.
  - **No polling. No git repo as brain or bus.**
- **Notifications, not commands:**
  - `RoomEventBody` kinds are `notice`, `event_proposal`, `ask`, `ack`, `enter`, `leave`, `presence`. There is **no kind that carries an instruction**.
  - Receiving companions render text as quoted data, inside a data-delimited block in the companion prompt with injection hygiene.
  - A companion may only **propose** to its own human ("¿Lo agendo?"). Rooms can't originate a session prompt; there is no `room:*` origin.
- **Encryption:**
  - A per-room symmetric key per **epoch**, wrapped to each member's client devices by an existing member's client.
  - **Leave/removal rotates the epoch.** The new key is wrapped only to remaining members, and `keyEpoch` is bumped. Events must carry the current epoch (rules check).
- **Addressing:** `to[]` (empty = all). Only addressed companions process the event, which saves tokens. Non-recipients in the scene see only a speech-bubble icon.
- **Retention (owner-only):**
  - `ephemeralTtl` defaults to `PT24H`. Allowed values are in `rooms.yaml`, plus `until_dissolved`.
  - `keepPromoted` defaults to true.
  - **Promotion** copies a durable record to the actor's `users/{uid}/records` (sealed blob in GCS if large) and clears `expireAt` on the event when `keepPromoted`.
- **Expiry:** Firestore TTL deletes lazily, so clients also filter `expireAt < now`.
- **Dissolve:** when the last member leaves or the owner deletes, `api` wipes events, members and invites in batches. Promoted records stay with their owners.
- **Identity:** `companionId = chl_` + 128-bit random base32. It is not searchable; companions reach each other only through invites.
- **Invites:** an Apple-style share (in-app or link). The invite is shown as a Glyph (ADR 0007), single-use by default, with a TTL. Only hashes of the glyph payload and short code are stored.
- **Scene:**
  - Choreography is deterministic and client-side: seeded wander (roomId + companionId + time bucket) plus room events. **Zero position writes.** Viewers can't control anyone.
  - Quality levels `auto|bajo|medio|alto` come from `render.yaml`.
- **Limits:** rooms per user and members per room come from tier inclusions (`mirror_matching_tier` until set). Values are progressive per tier in `plans.yaml` (owner decision #1).

## Update (M11): implemented on Supabase
The data layer moved to Supabase before M11 (ADR 0017), so the Firestore and Pub/Sub details above map as follows. Everything else (epochs, addressing, notifications-not-commands, retention, promotion, identity) is unchanged.
- **Data:** tables `chalito.rooms`, `room_members`, `room_events`, `room_invites` (`supabase/migrations/20261004001400_chalito_rooms.sql`). Invites are stored only as hashes of the glyph payload and the short code.
- **Writes:** only the api writes, as `chalito_server`, through `chalito_private.room_*` security-definer functions that enforce the room rules in one transaction (own companion, current epoch, owner-only retention/dissolve, rotation pending after a leave). **Reads:** RLS, members only.
- **Fan-out:** Supabase Realtime private topics `chalito:room:<id>` carrying pointer payloads; the client fetches the row. Offline members still get a metadata-only push from the notifier.
- **Expiry:** RLS hides `expires_at <= now()` and the pg_cron job `chalito-purge-rooms` deletes expired events every minute.

