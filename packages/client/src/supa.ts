/**
 * The slice of supabase-js the client data layer uses (schema `chalito`). Narrow on
 * purpose, like the agent's: unit tests run against an in-memory fake, and the real client
 * is cast once in auth.ts.
 */
export interface SupaResult<T = unknown> {
  data: T | null;
  error: { message: string; code?: string } | null;
}
export interface SupaQuery extends PromiseLike<SupaResult> {
  select(columns?: string): SupaQuery;
  insert(row: Record<string, unknown>): SupaQuery;
  update(patch: Record<string, unknown>): SupaQuery;
  delete(): SupaQuery;
  eq(column: string, value: unknown): SupaQuery;
  gt(column: string, value: unknown): SupaQuery;
  order(column: string, opts?: { ascending?: boolean }): SupaQuery;
  limit(n: number): SupaQuery;
  maybeSingle(): SupaQuery;
}
export interface SupaChannel {
  on(
    type: "broadcast",
    filter: { event: string },
    cb: (msg: { event?: string; payload?: unknown }) => void,
  ): SupaChannel;
  subscribe(cb?: (status: string, err?: Error) => void): SupaChannel;
}
export interface SupaClient {
  /**
   * realtime-js 2.117: `setAuth()` returns a Promise (no argument = take the session's token).
   * Joins must wait for it, or the private topic is joined with a stale or missing token.
   */
  realtime?: { setAuth(token?: string | null): unknown };
  from(table: string): SupaQuery;
  channel(topic: string, opts: { config: { private: boolean } }): SupaChannel;
  removeChannel(ch: SupaChannel): Promise<unknown>;
}

/** `chalito:device:<id>` (namespaced topics, security review S4). */
export const deviceTopic = (deviceId: string) => `chalito:device:${deviceId}`;

export class SupabaseError extends Error {
  override name = "SupabaseError";
  constructor(
    readonly op: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`${op}: ${message}`);
  }
}

export const must = async <T>(op: string, q: PromiseLike<SupaResult>): Promise<T> => {
  const { data, error } = await q;
  if (error) throw new SupabaseError(op, error.code, error.message);
  return data as T;
};

const rateLimited = (e: SupaResult["error"]) =>
  !!e && (e.code === "PT429" || e.code === "429" || /rate limit/i.test(e.message));

export interface RetryOptions {
  baseMs: number;
  attempts: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A write, retried with jittered exponential backoff while the database answers 429 (S7). */
export const writeWithRetry = async <T>(
  op: string,
  run: () => PromiseLike<SupaResult>,
  retry: RetryOptions = { baseMs: 250, attempts: 5 },
): Promise<T> => {
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await run();
    if (!error) return data as T;
    if (!rateLimited(error) || attempt >= retry.attempts) throw new SupabaseError(op, error.code, error.message);
    await sleep(retry.baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5));
  }
};
