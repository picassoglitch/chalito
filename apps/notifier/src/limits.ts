import type { Limit, RouteTable } from "@chalito/guard";

const KB = 1024;
/**
 * Google's push (Pub/Sub, Cloud Tasks) arrives from few addresses at high rates: generous, so a
 * burst is never throttled; a 429 would only make Google retry with backoff anyway.
 */
const google: Limit = { capacity: 3000, refillPerSec: 200, bodyBytes: 64 * KB };
/** Provider webhooks (Twilio, Meta, OpenAI): signed, from the providers' ranges. */
const provider = (bodyBytes: number): Limit => ({ capacity: 600, refillPerSec: 20, bodyBytes });

/**
 * Every route the notifier serves, with its per-IP limit and body cap (M15). Enforced by the
 * guard mounted first in createApp; test/route-limits.test.ts fails on a route without an entry.
 */
export const NOTIFIER_ROUTES: RouteTable = {
  "GET /healthz": { capacity: 120, refillPerSec: 10, bodyBytes: 0 },
  "POST /pubsub/notifications": google,
  "POST /pubsub/room-events": google,
  "POST /tasks/tick": google,
  // Cloud Scheduler, once a minute.
  "POST /tasks/drain-usage": { capacity: 30, refillPerSec: 0.5, bodyBytes: 4 * KB },
  "POST /webhooks/twilio/gather": provider(32 * KB),
  "POST /webhooks/twilio/sms": provider(32 * KB),
  "POST /webhooks/twilio/status": provider(32 * KB),
  "POST /webhooks/openai": provider(64 * KB),
  // Meta's one-off subscription check.
  "GET /webhooks/whatsapp": { capacity: 30, refillPerSec: 0.5, bodyBytes: 0 },
  "POST /webhooks/whatsapp": provider(256 * KB),
};
