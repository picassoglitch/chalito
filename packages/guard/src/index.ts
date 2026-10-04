import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Sql } from "postgres";

/**
 * A route's limits: a token bucket per client IP (capacity, refill per second) and a request
 * body cap. `shared` buckets live in Postgres, so the limit holds across every Cloud Run instance
 * (global caps for the expensive or abusable routes); the rest are per-instance, in memory.
 */
export interface Limit {
  capacity: number;
  refillPerSec: number;
  bodyBytes: number;
  shared?: boolean;
}

/** `"METHOD /path/:param"` → its limit. Every route an app serves must have an entry. */
export type RouteTable = Record<string, Limit>;

export interface BucketStore {
  /** Takes one token; false when the bucket is empty. */
  take(key: string, capacity: number, refillPerSec: number, now: number): Promise<boolean>;
}

export class MemoryBuckets implements BucketStore {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  async take(key: string, capacity: number, refillPerSec: number, now: number) {
    const b = this.#buckets.get(key) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.#buckets.set(key, b);
    if (this.#buckets.size > 100_000) this.#buckets.clear();
    return ok;
  }
}

/**
 * chalito_private.http_rate_buckets (migration 20261004002700), one row per hashed key, as
 * chalito_server. The refill and take happen in one upsert, so concurrent instances can't both
 * spend the last token.
 */
export class PostgresBuckets implements BucketStore {
  constructor(private readonly sql: Sql) {}
  async take(key: string, capacity: number, refillPerSec: number, now: number) {
    const at = new Date(now);
    // A refused take changes nothing (no row comes back), so refusals never dig the bucket deeper.
    const refilled = this.sql`least(${capacity}::numeric,
      b.tokens + greatest(0, extract(epoch from ${at}::timestamptz - b.updated_at)) * ${refillPerSec})`;
    const rows = await this.sql`
      insert into chalito_private.http_rate_buckets as b (key_hash, tokens, updated_at)
      values (${key}, ${capacity - 1}, ${at})
      on conflict (key_hash) do update
        set tokens = ${refilled} - 1, updated_at = greatest(b.updated_at, ${at}::timestamptz)
        where ${refilled} >= 1
      returning tokens`;
    return rows.length > 0;
  }
}

/**
 * The client IP. Cloud Run's front end appends the caller's address to X-Forwarded-For, so the
 * rightmost entry is the one a client can't forge; each trusted proxy in front (an external load
 * balancer) adds one more on the right.
 */
export const clientIp = (c: Context, trustedProxies = 0) => {
  const parts = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[parts.length - 1 - trustedProxies] ?? parts[0] ?? "local";
};

const compile = (route: string) => {
  const [method, path] = route.split(" ") as [string, string];
  const re = new RegExp(
    `^${path
      .split("/")
      .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg === "*" ? ".*" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}/?$`,
  );
  return { route, method, re };
};

/** The strictest sensible default for anything not in the table (404s, scanners). */
export const DEFAULT_LIMIT: Limit = { capacity: 30, refillPerSec: 0.5, bodyBytes: 1024 };

/**
 * One middleware, mounted first, that rate-limits and size-caps every request from the app's
 * route table. Unknown paths get DEFAULT_LIMIT. A shared bucket that can't reach Postgres falls
 * back to the instance's memory bucket rather than failing the request.
 */
export const guard = (
  table: RouteTable,
  opts: { shared?: BucketStore; trustedProxies?: number; now?: () => number; defaultLimit?: Limit } = {},
): MiddlewareHandler => {
  const routes = Object.keys(table).map(compile);
  const memory = new MemoryBuckets();
  const now = opts.now ?? Date.now;
  const fallback = opts.defaultLimit ?? DEFAULT_LIMIT;
  const capped = new Map<number, MiddlewareHandler>();
  const capFor = (bytes: number) => {
    let mw = capped.get(bytes);
    if (!mw) {
      mw = bodyLimit({ maxSize: bytes, onError: (c) => c.json({ error: "payload_too_large" }, 413) });
      capped.set(bytes, mw);
    }
    return mw;
  };
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    const hit = routes.find((r) => (r.method === method || r.method === "ALL") && r.re.test(path));
    const limit = hit ? table[hit.route]! : fallback;
    const group = hit?.route ?? "default";
    const key = createHash("sha256")
      .update(`${group}\n${clientIp(c, opts.trustedProxies)}`)
      .digest("hex");
    const t = now();
    let ok: boolean;
    if (limit.shared && opts.shared) {
      try {
        ok = await opts.shared.take(key, limit.capacity, limit.refillPerSec, t);
      } catch (err) {
        console.error("[guard] shared bucket unavailable", err instanceof Error ? err.message : "error");
        ok = await memory.take(key, limit.capacity, limit.refillPerSec, t);
      }
    } else ok = await memory.take(key, limit.capacity, limit.refillPerSec, t);
    if (!ok) {
      c.header("retry-after", String(Math.max(1, Math.ceil(1 / limit.refillPerSec))));
      return c.json({ error: "rate_limited" }, 429);
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > limit.bodyBytes) return c.json({ error: "payload_too_large" }, 413);
    if (method === "GET" || method === "DELETE") return next();
    return capFor(limit.bodyBytes)(c, next);
  };
};
