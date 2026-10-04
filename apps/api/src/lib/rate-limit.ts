import type { MiddlewareHandler } from "hono";
import { clientIp } from "@chalito/guard";
import { fail } from "./errors.js";

/**
 * In-memory token bucket per client IP and route group (brief §1: no separate cache
 * service). Cloud Run instances each keep their own buckets; global caps are the `shared` routes of @chalito/guard (M15).
 */
export const rateLimit = (opts: { capacity: number; refillPerSec: number; now?: () => number }): MiddlewareHandler => {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const now = opts.now ?? Date.now;
  return async (c, next) => {
    const ip = clientIp(c);
    const t = now();
    const b = buckets.get(ip) ?? { tokens: opts.capacity, at: t };
    b.tokens = Math.min(opts.capacity, b.tokens + ((t - b.at) / 1000) * opts.refillPerSec);
    b.at = t;
    if (b.tokens < 1) {
      buckets.set(ip, b);
      fail(429, "rate_limited");
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    if (buckets.size > 50_000) buckets.clear();
    await next();
  };
};
