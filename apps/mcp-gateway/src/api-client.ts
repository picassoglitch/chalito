import type { SealedEnvelope } from "@chalito/protocol";

/**
 * The gateway's writes, through the api (D-035): the gateway's service token plus the caller's
 * own access token, so the api re-checks the grant and its scopes before writing anything.
 */
export class GatewayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`api ${status}: ${code}`);
  }
}

export class GatewayApi {
  constructor(
    private readonly base: string,
    private readonly serviceToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async #post<T>(path: string, accessToken: string, body: unknown): Promise<T | null> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.serviceToken}`,
        "x-chalito-access-token": accessToken,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    if (!res.ok) throw new GatewayApiError(res.status, String(json?.error ?? "error"));
    return json as T | null;
  }

  recommend(accessToken: string, b: { aid: string; allow: boolean; note: string }) {
    return this.#post<null>("/v1/gateway/recommendations", accessToken, b);
  }
  mesaTurn(accessToken: string, b: { mid?: string; ct: SealedEnvelope }) {
    return this.#post<{ tid: string }>("/v1/gateway/mesa-turns", accessToken, b);
  }
  prompt(accessToken: string, b: { cid: string; sid: string; promptCt: SealedEnvelope }) {
    return this.#post<{ cid: string; targetDeviceId: string }>("/v1/gateway/prompts", accessToken, b);
  }
  audit(accessToken: string, b: { tool: "list_pending" | "get_session_card"; target?: string }) {
    return this.#post<null>("/v1/gateway/audit", accessToken, b);
  }
}
