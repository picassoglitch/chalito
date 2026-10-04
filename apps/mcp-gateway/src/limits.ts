import type { RouteTable } from "@chalito/guard";

/**
 * Every route the MCP gateway serves, with its per-IP limit and body cap (M15). The MCP endpoint's
 * path comes from the resource URL, so the table does too. Enforced by the guard mounted first in
 * createGateway; test/route-limits.test.ts fails on a route without an entry. The gateway's
 * database role is read-only, so its buckets are per instance.
 */
export const gatewayRoutes = (resource: string): RouteTable => {
  const path = new URL(resource).pathname;
  const metadata = { capacity: 120, refillPerSec: 5, bodyBytes: 0 };
  return {
    "GET /healthz": { capacity: 120, refillPerSec: 10, bodyBytes: 0 },
    "GET /.well-known/oauth-protected-resource": metadata,
    [`GET /.well-known/oauth-protected-resource${path}`]: metadata,
    // MCP over streamable HTTP: one request per tool call; prompts are capped at 8000 chars.
    [`ALL ${path}`]: { capacity: 120, refillPerSec: 2, bodyBytes: 64 * 1024 },
  };
};
