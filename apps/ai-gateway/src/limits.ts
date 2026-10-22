import type { RouteTable } from "@chalito/guard";

const MB = 1024 * 1024;
/** Per-IP limits and body caps for every route (M15); test/route-limits.test.ts fails on a missing entry. */
export const gatewayRoutes = (): RouteTable => ({
  "GET /healthz": { capacity: 120, refillPerSec: 10, bodyBytes: 0 },
  "GET /health": { capacity: 120, refillPerSec: 10, bodyBytes: 0 },
  // A coding agent's whole context goes up on every request; per-token buckets in app.ts sit behind these.
  "POST /v1/responses": { capacity: 240, refillPerSec: 4, bodyBytes: 16 * MB },
  "GET /v1/models": { capacity: 60, refillPerSec: 1, bodyBytes: 0 },
  "POST /v1beta/models/:target": { capacity: 240, refillPerSec: 4, bodyBytes: 16 * MB },
});
