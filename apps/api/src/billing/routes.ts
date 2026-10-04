import { Hono } from "hono";
import { HubUnavailable, type HubClient } from "@chalito/billing";
import type { HubBalance } from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";

export interface BillingDeps {
  hub: Pick<HubClient, "balance">;
  /** How long one owner's balance is reused (default 30 s). */
  ttlMs?: number;
  /** Owners cached at once; the oldest entry goes first (default 10 000). */
  maxEntries?: number;
}

export const BALANCE_TTL_MS = 30_000;

/**
 * GET /v1/billing/balance: the owner's hub balance for /creditos, in tokens only (the hub's
 * TokenBalance; no prices or currency ever pass through Chalito). Cached per owner for ~30 s so a
 * page that polls doesn't turn into hub traffic; a hub failure is 503 hub_unavailable and isn't
 * cached.
 */
export const billingRoutes = (deps: Deps, billing: BillingDeps) => {
  const app = new Hono<AuthEnv>();
  const ttl = billing.ttlMs ?? BALANCE_TTL_MS;
  const max = billing.maxEntries ?? 10_000;
  const cache = new Map<string, { at: number; balance: HubBalance }>();

  app.get("/balance", requireAuth(deps, ["user", "client"]), async (c) => {
    const { owner } = principal(c);
    const now = deps.now();
    const hit = cache.get(owner);
    let balance = hit && now - hit.at < ttl ? hit.balance : null;
    if (!balance) {
      try {
        balance = await billing.hub.balance(owner);
      } catch (err) {
        if (err instanceof HubUnavailable) return fail(503, "hub_unavailable");
        // A malformed answer is the hub's problem too, never a 500 for the page.
        console.error("[billing] balance failed", err instanceof Error ? err.name : "error");
        return fail(503, "hub_unavailable");
      }
      cache.delete(owner);
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
      cache.set(owner, { at: now, balance });
    }
    const { remaining, unlimited, monthlyAllocation, bonus, monthlyUsed, reserved, periodStart } = balance;
    c.header("cache-control", "private, no-store");
    return c.json({ remaining, unlimited, monthlyAllocation, bonus, monthlyUsed, reserved, periodStart });
  });

  return app;
};
