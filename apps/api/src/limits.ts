import type { Limit, RouteTable } from "@chalito/guard";

const KB = 1024;
/** Bodies: most requests are small JSON; ciphertext-carrying routes get more room. */
const SMALL = 8 * KB;
const MEDIUM = 32 * KB;
const SEALED = 256 * KB;

const health: Limit = { capacity: 120, refillPerSec: 10, bodyBytes: 0 };
/** Server-to-server callers (the Chalyb hub, the MCP gateway): high, but still bounded. */
const s2s = (bodyBytes = MEDIUM): Limit => ({ capacity: 600, refillPerSec: 20, bodyBytes });
/** Guessable or costly (codes, enrolment, recovery, SMS, client registration): global, in Postgres. */
const sensitive = (capacity: number, perMinute: number, bodyBytes = SMALL): Limit => ({
  capacity,
  refillPerSec: perMinute / 60,
  bodyBytes,
  shared: true,
});
/** Signed-in reads and ordinary writes. */
const user = (capacity: number, perSec: number, bodyBytes = SMALL): Limit => ({
  capacity,
  refillPerSec: perSec,
  bodyBytes,
});

/**
 * Every route the api serves, with its per-IP limit and body cap (M15). The guard mounted first in
 * createApp enforces this table; test/route-limits.test.ts fails when a route is missing from it.
 * Route-level limiters inside the routers stay as a second, tighter layer.
 */
export const API_ROUTES: RouteTable = {
  "GET /healthz": health,

  // Chalyb hub (engine contract + SSO)
  "POST /tenants": s2s(),
  "POST /tenants/:id/status": s2s(),
  "POST /sso/exchange": sensitive(30, 30),

  // Devices, pairing, endorsement, recovery, passkeys
  "POST /v1/devices/first": sensitive(10, 2, MEDIUM),
  "POST /v1/devices/endorsed": sensitive(10, 2, MEDIUM),
  "POST /v1/devices/token": user(30, 0.5),
  "POST /v1/devices/revoke": user(20, 0.2),
  "POST /v1/devices/revoke-all": sensitive(5, 1, 256 * KB),
  "POST /v1/pairing/codes": sensitive(10, 6),
  "POST /v1/pairing/resolve": sensitive(20, 6),
  "POST /v1/pairing/claim": sensitive(20, 6, MEDIUM),
  "POST /v1/endorse/codes": sensitive(20, 6),
  "POST /v1/endorse/resolve": sensitive(20, 6),
  "POST /v1/endorse/approve": sensitive(20, 6, MEDIUM),
  "POST /v1/endorse/take": sensitive(20, 6, MEDIUM),
  "POST /v1/recovery/start": sensitive(5, 1),
  "POST /v1/recovery/complete": sensitive(5, 1),
  "POST /v1/webauthn/register/options": user(20, 0.5),
  "POST /v1/webauthn/register/verify": user(20, 0.5, MEDIUM),
  "POST /v1/webauthn/register/bind": user(20, 0.5, MEDIUM),
  "POST /v1/webauthn/assert/options": user(30, 1),

  // OAuth 2.1 authorization server for MCP connectors
  "GET /.well-known/oauth-authorization-server": health,
  "GET /.well-known/openid-configuration": health,
  "POST /oauth/register": sensitive(10, 2),
  "GET /oauth/authorize": user(30, 1, 0),
  "GET /oauth/requests/:id": user(60, 1, 0),
  "POST /oauth/requests/:id/approve": user(30, 0.5),
  "POST /oauth/requests/:id/deny": user(30, 0.5),
  "POST /oauth/token": user(30, 1),
  "POST /oauth/revoke": user(30, 0.5),
  "GET /v1/connectors": user(60, 1, 0),
  "POST /v1/connectors/:cid/revoke": user(30, 0.5),
  "POST /v1/mcp/sharing": user(30, 0.5),
  // From the MCP gateway (service identity)
  "POST /v1/gateway/recommendations": s2s(),
  "POST /v1/gateway/mesa-turns": s2s(),
  "POST /v1/gateway/prompts": s2s(),
  "POST /v1/gateway/audit": s2s(),

  // Phone verification (each start sends an SMS: global cap)
  "POST /v1/phone/start": sensitive(5, 0.5, 2 * KB),
  "POST /v1/phone/check": sensitive(10, 2, 2 * KB),
  "POST /v1/phone/channels": user(30, 0.5, 2 * KB),
  "DELETE /v1/phone": user(10, 0.1, 0),

  // Desktop push-to-talk
  "POST /v1/voice/session": user(20, 0.2, 2 * KB),
  // The desktop's WebRTC offer (a few KB of SDP), once per session.
  "POST /v1/voice/session/sdp": user(20, 0.2, 32 * KB),
  "POST /v1/voice/session/heartbeat": user(120, 2, 2 * KB),
  "POST /v1/voice/session/end": user(30, 1, 2 * KB),

  // Store
  "GET /v1/store/catalog": user(60, 1, 0),
  "POST /v1/store/purchase": user(20, 0.5, 2 * KB),
  "POST /v1/store/equip": user(60, 1, 2 * KB),
  "GET /v1/billing/balance": user(60, 1, 0),

  // Rooms (sealed payloads)
  "POST /v1/rooms": user(20, 0.2, MEDIUM),
  "POST /v1/rooms/:roomId/invites": user(30, 0.5, MEDIUM),
  "POST /v1/rooms/join": sensitive(20, 6, MEDIUM),
  "POST /v1/rooms/:roomId/members/:companionId/devices": user(30, 0.5, MEDIUM),
  "POST /v1/rooms/:roomId/keys": user(30, 0.5, SEALED),
  "POST /v1/rooms/:roomId/leave": user(20, 0.2),
  "POST /v1/rooms/:roomId/rotate": user(20, 0.2, SEALED),
  "POST /v1/rooms/:roomId/dissolve": user(10, 0.1),
  "POST /v1/rooms/:roomId/events": user(120, 5, SEALED),
  "POST /v1/rooms/:roomId/events/:eid/promote": user(30, 0.5),
  "POST /v1/rooms/:roomId/retention": user(20, 0.2),
  "POST /v1/rooms/:roomId/reports": user(20, 0.2, 8 * KB),

  // Account deletion (ARCO) and export
  "GET /v1/account/deletion": user(30, 0.5, 0),
  "POST /v1/account/deletion": sensitive(5, 0.1, 32 * KB),
  "DELETE /v1/account/deletion": user(10, 0.1, 0),
  "GET /v1/account/export": sensitive(10, 0.2, 0),
  // Cloud Scheduler (OIDC)
  "POST /tasks/account-deletions": { capacity: 30, refillPerSec: 0.5, bodyBytes: 4 * KB },

  // Desktop updater manifest (signed URLs to the private releases bucket)
  "GET /releases/:channel/latest.json": user(30, 1, 0),
};
