import type { RouteTable } from "@chalito/guard";

const KB = 1024;

/**
 * Every route the orchestrator serves, with its per-IP limit and body cap (M15). Enforced by the
 * guard mounted first in createOrchestrator; test/route-limits.test.ts fails on a route without an
 * entry. Turns spend model tokens, so they're the tightest; budgets and the hub's admit still apply.
 */
export const ORCHESTRATOR_ROUTES: RouteTable = {
  "GET /healthz": { capacity: 120, refillPerSec: 10, bodyBytes: 0 },
  // Cloud Scheduler (OIDC), once a minute.
  "POST /tasks/sweep-decisions": { capacity: 30, refillPerSec: 0.5, bodyBytes: 4 * KB },
  "POST /v1/mesas": { capacity: 10, refillPerSec: 0.1, bodyBytes: 32 * KB },
  "POST /v1/mesas/:mid/turns": { capacity: 30, refillPerSec: 0.5, bodyBytes: 64 * KB },
  "POST /v1/decisions/:aid/check": { capacity: 30, refillPerSec: 0.5, bodyBytes: 8 * KB },
  "PUT /v1/brain-keys/:provider": { capacity: 10, refillPerSec: 0.05, bodyBytes: 8 * KB },
  "DELETE /v1/brain-keys/:provider": { capacity: 10, refillPerSec: 0.05, bodyBytes: 0 },
  "GET /v1/usage/daily": { capacity: 30, refillPerSec: 0.5, bodyBytes: 0 },
};
