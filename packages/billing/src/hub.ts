import {
  HubAdmitRequest,
  HubAdmitResponse,
  HubBalanceResponse,
  HubSettle,
  HubUsageBatch,
  type HubBalance,
  type HubUsageEvent,
} from "@chalito/protocol";
import type { z } from "zod";

/** The only hub Chalito talks to (ADR 0016). Anything else is a misconfiguration. */
export const CHALYB_BASE_URL = "https://www.chalyb.com";
export const ENGINE_SLUG = "chalito";

export type UsageResult =
  | { status: "ok" }
  /** Network error, 5xx, 408 or 429: try again later. */
  | { status: "retry"; httpStatus: number | null; error: string }
  /** Any other 4xx is permanent: mark dead and alert, never drop. */
  | { status: "dead"; httpStatus: number; error: string };

/** The hub can't answer: 5xx, unknown user or engine (404), or admit isn't deployed yet. */
export class HubUnavailable extends Error {
  constructor(
    readonly httpStatus: number | null,
    message: string,
  ) {
    super(message);
  }
}

export type SettleResult =
  | { ok: true }
  /** 409: the reservation is already closed (a heartbeat on it means: stop). */
  | { ok: false; closed: true }
  | { ok: false; closed: false; httpStatus: number };

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

  /**
   * Before any managed spend. A refusal is an answer (200, allowed: false); anything else —
   * including 404 (unknown user, engine not registered, or a hub without the admit route) —
   * throws HubUnavailable, which callers treat as "no" (fail closed, free_min).
   */
  async admit(req: z.input<typeof HubAdmitRequest>): Promise<HubAdmitResponse> {
    const body = HubAdmitRequest.parse(req);
    let res: Response;
    try {
      res = await this.#call("POST", "/usage/admit", body);
    } catch (err) {
      throw new HubUnavailable(null, err instanceof Error ? err.message : "network error");
    }
    if (!res.ok) throw new HubUnavailable(res.status, `hub admit failed: ${res.status}`);
    return HubAdmitResponse.parse(await res.json());
  }

  /**
   * Reports up to 100 events for ONE user (the hub takes `external_user_id` at the top level).
   * Never throws for HTTP outcomes; the outbox decides what to do.
   */
  async usage(externalUserId: string, events: HubUsageEvent[]): Promise<UsageResult> {
    const batch = HubUsageBatch.parse({ external_user_id: externalUserId, events });
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

  /** Settling twice is a no-op on the hub; a heartbeat on a closed reservation is 409. */
  async settle(st: z.input<typeof HubSettle>): Promise<SettleResult> {
    const res = await this.#call("POST", "/usage/settle", HubSettle.parse(st));
    if (res.ok) return { ok: true };
    if (res.status === 409) return { ok: false, closed: true };
    return { ok: false, closed: false, httpStatus: res.status };
  }

  /**
   * The user's billable-token balance: {ok: true, balance: TokenBalance}, parsed strictly.
   * 404 (unknown user_id) and other failures throw HubUnavailable.
   */
  async balance(externalUserId: string): Promise<HubBalance> {
    const res = await this.#call("GET", `/usage/balance?external_user_id=${encodeURIComponent(externalUserId)}`);
    if (!res.ok) throw new HubUnavailable(res.status, `hub balance failed: ${res.status}`);
    return HubBalanceResponse.parse(await res.json()).balance;
  }
}
