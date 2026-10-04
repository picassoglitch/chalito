import { HubAdmitRequest, HubAdmitResponse, HubSettle, HubUsageBatch, type HubUsageEvent } from "@chalito/protocol";
import { z } from "zod";

/** The only hub Chalito talks to (ADR 0016). Anything else is a misconfiguration. */
export const CHALYB_BASE_URL = "https://www.chalyb.com";
export const ENGINE_SLUG = "chalito";

export type UsageResult =
  | { status: "ok" }
  /** Network error, 5xx, 408 or 429: try again later. */
  | { status: "retry"; httpStatus: number | null; error: string }
  /** Any other 4xx is permanent: mark dead and alert, never drop. */
  | { status: "dead"; httpStatus: number; error: string };

const Balance = z.object({ remaining: z.number(), reserved: z.number().default(0) }).passthrough();

/**
 * The Chalyb engine contract client (docs/VERIFIED_APIS.md "Chalyb hub engine contract"):
 * admit / usage (≤ 100 events, cost_usd_micros on each, idempotent source_id) / settle /
 * balance, with the engine bearer (CHALITO_ADMIN_TOKEN).
 */
export class HubClient {
  readonly #base: string;

  constructor(private readonly opts: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    if (opts.baseUrl.replace(/\/$/, "") !== CHALYB_BASE_URL)
      throw new Error(`CHALYB_BASE_URL must be ${CHALYB_BASE_URL} (got ${opts.baseUrl})`);
    if (!opts.token) throw new Error("CHALITO_ADMIN_TOKEN is required");
    this.#base = `${CHALYB_BASE_URL}/api/engines/${ENGINE_SLUG}`;
  }

  #call(method: "GET" | "POST", path: string, body?: unknown) {
    return (this.opts.fetch ?? fetch)(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Before any managed spend. A refusal is an answer, not an error. */
  async admit(req: z.input<typeof HubAdmitRequest>): Promise<HubAdmitResponse> {
    const res = await this.#call("POST", "/usage/admit", HubAdmitRequest.parse(req));
    if (!res.ok) throw new Error(`hub admit failed: ${res.status}`);
    return HubAdmitResponse.parse(await res.json());
  }

  /** Reports up to 100 events. Never throws for HTTP outcomes; the outbox decides what to do. */
  async usage(events: HubUsageEvent[]): Promise<UsageResult> {
    const batch = HubUsageBatch.parse({ events });
    let res: Response;
    try {
      res = await this.#call("POST", "/usage", batch);
    } catch (err) {
      return { status: "retry", httpStatus: null, error: err instanceof Error ? err.message : "network error" };
    }
    if (res.ok) return { status: "ok" };
    const error = (await res.text().catch(() => "")).slice(0, 500);
    if (res.status >= 500 || res.status === 408 || res.status === 429)
      return { status: "retry", httpStatus: res.status, error };
    return { status: "dead", httpStatus: res.status, error };
  }

  /** Settling twice is a no-op on the hub. */
  async settle(s: z.input<typeof HubSettle>): Promise<void> {
    const res = await this.#call("POST", "/usage/settle", HubSettle.parse(s));
    if (!res.ok) throw new Error(`hub settle failed: ${res.status}`);
  }

  /** The user's billable-token balance. Accepts `{remaining, reserved}` or `{balance: {...}}`. */
  async balance(externalUserId: string): Promise<z.infer<typeof Balance>> {
    const res = await this.#call("GET", `/usage/balance?external_user_id=${encodeURIComponent(externalUserId)}`);
    if (!res.ok) throw new Error(`hub balance failed: ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    return Balance.parse(json.balance ?? json);
  }
}
