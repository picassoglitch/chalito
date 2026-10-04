/**
 * The Chalyb hub's request validation, copied rule for rule from its source so our hub mock refuses
 * exactly what the real hub refuses. Read-only from picassoglitch/chalyb:
 *   - a5733df (a5733dfdb2ceb8c1555d043cfc820c6dc33324e1, branch claude/consumption-caps): admit,
 *     settle, the stricter usage body;
 *   - origin/main 3f27ef3 (3f27ef391607ea8f8772df1a00da72a18eb54443): usage and balance, the same
 *     top-level external_user_id rule.
 * Update this file, with the new file:line and sha, whenever the hub's contract changes.
 */

type Refusal = { status: number; error: string };

// src/lib/usage/event-validation.ts:9-23 @ a5733df
export const MAX_EVENTS_PER_REQUEST = 100;
const MAX_AMOUNT = 1e12;
const MAX_COST_USD_MICROS = 1e9;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_METADATA_BYTES = 4096;
const KIND_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const PROVIDER_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const OPERATION_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const SOURCE_ID_RE = /^[\s\S]{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isInt = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/**
 * POST /api/engines/{slug}/usage. src/app/api/engines/[slug]/usage/route.ts:75-78 @ a5733df (and
 * the same check on main 3f27ef3): `body.external_user_id` must be a string. Then
 * validateUsageEvents, src/lib/usage/event-validation.ts:47-140 @ a5733df.
 */
export const checkUsageRequest = (body: unknown, nowMs: number): Refusal | null => {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { status: 400, error: "invalid JSON" };
  if (!b.external_user_id || typeof b.external_user_id !== "string")
    return { status: 400, error: "external_user_id required" };
  const raw = b.events;
  if (!Array.isArray(raw)) return null; // no events: the hub just returns the balance
  if (raw.length > MAX_EVENTS_PER_REQUEST) return { status: 413, error: "at most 100 events per request" };
  for (const item of raw) {
    const e = item as Record<string, unknown> | null;
    if (!e || typeof e !== "object") return { status: 400, error: "event must be an object" };
    if (typeof e.kind !== "string" || !KIND_RE.test(e.kind)) return { status: 400, error: "invalid kind" };
    if (typeof e.source_id !== "string" || !SOURCE_ID_RE.test(e.source_id))
      return { status: 400, error: "source_id required (≤200 chars)" };
    if (typeof e.amount !== "number" || !Number.isFinite(e.amount)) return { status: 400, error: "invalid amount" };
    if (!isInt(e.amount, MAX_AMOUNT)) return { status: 422, error: "amount must be an integer" };
    if (e.cost_usd_micros !== undefined && e.cost_usd_micros !== null && !isInt(e.cost_usd_micros, MAX_COST_USD_MICROS))
      return { status: 422, error: "cost_usd_micros must be an integer" };
    if (
      e.provider !== undefined &&
      e.provider !== null &&
      (typeof e.provider !== "string" || !PROVIDER_RE.test(e.provider))
    )
      return { status: 400, error: "invalid provider" };
    if (
      e.operation !== undefined &&
      e.operation !== null &&
      (typeof e.operation !== "string" || !OPERATION_RE.test(e.operation))
    )
      return { status: 400, error: "invalid operation" };
    if (
      e.reservation_id !== undefined &&
      e.reservation_id !== null &&
      (typeof e.reservation_id !== "string" || !UUID_RE.test(e.reservation_id))
    )
      return { status: 400, error: "invalid reservation_id" };
    if (e.metadata !== undefined && e.metadata !== null) {
      if (typeof e.metadata !== "object" || Array.isArray(e.metadata))
        return { status: 400, error: "metadata must be an object" };
      if (JSON.stringify(e.metadata).length > MAX_METADATA_BYTES) return { status: 422, error: "metadata too large" };
    }
    if (e.occurred_at !== undefined && e.occurred_at !== null) {
      const t = typeof e.occurred_at === "string" ? Date.parse(e.occurred_at) : NaN;
      if (Number.isNaN(t)) return { status: 400, error: "invalid occurred_at" };
      if (t > nowMs + MAX_CLOCK_SKEW_MS) return { status: 422, error: "occurred_at is in the future" };
      if (t < nowMs - MAX_EVENT_AGE_MS) return { status: 422, error: "occurred_at is older than 7 days" };
    }
  }
  return null;
};

// src/lib/usage/admission-core.ts:39-44 @ a5733df
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_EST_TOKENS = 1e11;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const OP_RE = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * POST /api/engines/{slug}/usage/admit. src/app/api/engines/[slug]/usage/admit/route.ts:35-42 and
 * parseAdmitBody, src/lib/usage/admission-core.ts:47-101 @ a5733df.
 */
export const checkAdmitRequest = (body: unknown): Refusal | null => {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { status: 400, error: "invalid JSON body" };
  if (!b.external_user_id || typeof b.external_user_id !== "string")
    return { status: 400, error: "external_user_id required" };
  if (typeof b.external_job_id !== "string" || !ID_RE.test(b.external_job_id))
    return { status: 400, error: "external_job_id required" };
  const cls = b.class ?? "job";
  if (cls !== "job" && cls !== "stream") return { status: 400, error: "class must be job or stream" };
  if (
    b.operation !== undefined &&
    b.operation !== null &&
    (typeof b.operation !== "string" || !OP_RE.test(b.operation))
  )
    return { status: 400, error: "invalid operation" };
  for (const [name, max] of [
    ["est_tokens", MAX_EST_TOKENS],
    ["upload_mb", 1e7],
    ["source_minutes", 1e6],
    ["storage_mb_after", 1e9],
  ] as const) {
    const v = b[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)
      return { status: 400, error: `invalid ${name}` };
  }
  if (b.boost !== undefined && b.boost !== null && typeof b.boost !== "boolean")
    return { status: 400, error: "boost must be true, false or null" };
  if (
    b.ttl_seconds !== undefined &&
    b.ttl_seconds !== null &&
    (typeof b.ttl_seconds !== "number" ||
      !Number.isInteger(b.ttl_seconds) ||
      b.ttl_seconds < 60 ||
      b.ttl_seconds > MAX_TTL_SECONDS)
  )
    return { status: 400, error: "ttl_seconds must be an integer between 60 and 86400" };
  return null;
};

/** POST /api/engines/{slug}/usage/settle. src/app/api/engines/[slug]/usage/settle/route.ts:28-36 @ a5733df. */
export const SETTLE_OUTCOMES = ["succeeded", "failed", "cancelled", "heartbeat"] as const;
export const checkSettleRequest = (body: unknown): Refusal | null => {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { status: 400, error: "invalid JSON" };
  if (typeof b.reservation_id !== "string" || !UUID_RE.test(b.reservation_id))
    return { status: 400, error: "reservation_id required" };
  if (!(SETTLE_OUTCOMES as readonly unknown[]).includes(b.outcome))
    return { status: 400, error: `outcome must be one of ${SETTLE_OUTCOMES.join(", ")}` };
  return null;
};

/** GET /api/engines/{slug}/usage/balance. src/app/api/engines/[slug]/usage/balance/route.ts:22-27 @ main 3f27ef3 and a5733df. */
export const checkBalanceRequest = (url: URL): Refusal | null =>
  url.searchParams.get("external_user_id") ? null : { status: 400, error: "external_user_id query param required" };

/** Every engine route: `Authorization: Bearer <SLUG>_ADMIN_TOKEN`. src/lib/engines/bearer.ts @ main 3f27ef3. */
export const checkBearer = (header: string | null, token: string): Refusal | null =>
  header === `Bearer ${token}` ? null : { status: 403, error: "invalid token" };
