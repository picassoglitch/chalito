/** The few API calls the key flows make. Inject a fake in tests; use `httpApi` in the app. */
export interface ApiClient {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`api ${status} ${code}`);
  }
}

export const httpApi = (o: {
  baseUrl: string;
  /** Current credential (hub session for `user` routes, device token for `client` routes). */
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
}): ApiClient => ({
  async post<T>(path: string, body: unknown): Promise<T> {
    const token = await o.token();
    const res = await (o.fetch ?? fetch)(new URL(path, o.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, json.error ?? "error");
    return json as T;
  },
});
