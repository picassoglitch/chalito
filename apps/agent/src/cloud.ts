import { createClient } from "@supabase/supabase-js";
import { randomNonce, signEnvelope } from "@chalito/crypto";
import { ApiError, DeviceTokenResponse } from "@chalito/protocol";
import type { AgentConfig, PairedConfig } from "./config.js";
import type { Identity } from "./identity.js";
import type { Logger } from "./redact.js";
import type { AgentStore } from "./store.js";
import { SupabaseStore, pairingTopic, type SupaClient } from "./supabase-store.js";

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code);
  }
}

/** POST JSON to the control plane; non-2xx becomes an ApiRequestError with the API's error code. */
export const postJson = async (fetchFn: FetchFn, url: string, body: unknown): Promise<unknown> => {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiError.safeParse(json);
    throw new ApiRequestError(res.status, err.success ? err.data.error : `http_${res.status}`, err.data?.message);
  }
  return json;
};

/**
 * Device credential: a fresh signature over a one-time challenge, exchanged for a
 * device sign-in credential (a magic-link token_hash for its Supabase Auth user). Nothing
 * bearer-like is stored on disk.
 */
export const fetchDeviceToken = async (
  fetchFn: FetchFn,
  cfg: PairedConfig,
  id: Identity,
  now: number,
): Promise<string> => {
  const challenge = await signEnvelope(
    "chalito.refresh-challenge.v1",
    { v: 1 as const, owner: cfg.owner, deviceId: id.deviceId, nonce: await randomNonce(), issuedAt: now },
    id.deviceId,
    id.sign.secretKey,
  );
  const res = DeviceTokenResponse.parse(await postJson(fetchFn, `${cfg.apiBase}/v1/devices/token`, challenge));
  if (res.deviceId !== id.deviceId) throw new Error("device token was issued for another device");
  return res.customToken;
};

/**
 * The daemon's view of the cloud: get credentials (first sign-in and every refresh), then
 * read/write through a store. Each backend owns its token cadence.
 */
export interface Cloud {
  /** Fetches fresh credentials and applies them. */
  refresh(): Promise<void>;
  readonly refreshIntervalMs: number;
  store(owner: string, deviceId: string): AgentStore;
  close(): Promise<void>;
}

/** Mints a device credential from Chalito's API (signed one-time challenge, see fetchDeviceToken). */
export type MintToken = () => Promise<string>;

type SupabaseConfig = Pick<NonNullable<AgentConfig["supabase"]>, "url" | "publishableKey">;

/** Waits on the pairing code with the single-code watch credential. */
export interface PairingWatcher {
  watch(
    watchToken: string,
    codeId: string,
    onDoc: (data: Record<string, unknown>) => void,
  ): Promise<() => Promise<void>>;
}

// ---------------------------------------------------------------- Supabase (ADR 0017)

/**
 * Where the device's Supabase access token comes from. Token-agnostic on purpose: the
 * mechanism is the owner's open decision (ADR 0017 §Tokens).
 */
export interface TokenSource {
  /** A valid access token (checked or renewed as needed); called at start and on every refresh tick. */
  getToken(): Promise<string>;
  readonly refreshIntervalMs: number;
  /** Tokens renewed in the background (supabase-js auto-refresh) are pushed here too. */
  onToken?(cb: (token: string) => void): void;
  close?(): Promise<void>;
}

/** Device JWTs live 5 minutes (ADR 0017); refresh with room to spare. */
export const SUPABASE_REFRESH_MS = 4 * 60 * 1000;

/**
 * Option A/B (not chosen; kept for the custom-issuer path): short-lived device JWTs minted by Chalito's API after the Ed25519 proof of
 * possession (`/v1/devices/token`, `iss = "chalito"`). Every refresh is a new challenge.
 */
export const apiTokenSource = (mint: MintToken, refreshIntervalMs = SUPABASE_REFRESH_MS): TokenSource => ({
  getToken: mint,
  refreshIntervalMs,
});

// Option C (the owner's choice), a Supabase Auth user per device: device-auth.ts.

/** What cloud.ts needs from a supabase-js client on top of SupaClient. */
export type RealtimeClient = SupaClient & {
  realtime: { setAuth(token?: string | null): unknown | Promise<unknown> };
  removeAllChannels(): Promise<unknown>;
};

export type CreateSupaClient = (
  url: string,
  publishableKey: string,
  accessToken: () => Promise<string | null>,
) => RealtimeClient;

/** supabase-js over schema `chalito`, authenticated only by the device token (no Supabase Auth session). */
export const createSupabaseClient: CreateSupaClient = (url, publishableKey, accessToken) =>
  createClient(url, publishableKey, {
    db: { schema: "chalito" },
    accessToken,
  }) as unknown as RealtimeClient;

export const supabaseCloud = (
  cfg: SupabaseConfig,
  tokens: TokenSource,
  opts: { create?: CreateSupaClient; log?: Logger } = {},
): Cloud => {
  let token: string | null = null;
  const client = (opts.create ?? createSupabaseClient)(cfg.url, cfg.publishableKey, async () => token);
  const stores: SupabaseStore[] = [];
  // Realtime caches join authorization until it sees a new token: hand over every new one.
  // realtime-js 2.117's setAuth is async: await it, so a join never races ahead of the token.
  const apply = async (t: string) => {
    if (t === token) return;
    token = t;
    await client.realtime.setAuth(t);
  };
  tokens.onToken?.((t) => void apply(t));
  return {
    refreshIntervalMs: tokens.refreshIntervalMs,
    refresh: async () => apply(await tokens.getToken()),
    store: (owner, deviceId) => {
      const s = new SupabaseStore(client, owner, deviceId, opts.log ? { log: opts.log } : {});
      stores.push(s);
      return s;
    },
    close: async () => {
      for (const s of stores) await s.close().catch(() => undefined);
      await client.removeAllChannels().catch(() => undefined);
      await tokens.close?.().catch(() => undefined);
    },
  };
};

/** pairing_codes row (snake_case) → the PairingCodeDoc shape the pairing flow parses. */
export const pairingRowToDoc = (r: Record<string, unknown>): Record<string, unknown> => ({
  v: 1,
  codeId: r.code_id,
  shortCodeHash: r.short_code_hash,
  glyph: r.glyph,
  agentDeviceId: r.agent_device_id,
  kind: r.kind,
  platform: r.platform,
  claimed: r.claimed,
  owner: r.owner ?? null,
  claimedByDeviceId: r.claimed_by_device_id ?? null,
  claimerPubSign: r.claimer_pub_sign ?? null,
  claimerPubBox: r.claimer_pub_box ?? null,
  claimerWebauthnBinding: r.claimer_webauthn_binding ?? null,
  expiresAt: typeof r.expires_at === "string" ? Date.parse(r.expires_at) : r.expires_at,
});

/**
 * Waits on `chalito:pairing:<code>` with the pairing-watch token (RLS lets it read only that topic
 * and that one row), then reads the row through the Data API. Reads once on SUBSCRIBED too,
 * in case the claim landed before the join.
 */
export const supabasePairingWatcher = (
  cfg: SupabaseConfig,
  opts: {
    create?: CreateSupaClient;
    /** Turns the API's watch credential into an access token (device-user mode: a magic-link exchange). */
    exchange?: (watchToken: string) => Promise<string>;
  } = {},
): PairingWatcher => ({
  watch: async (watchToken, codeId, onDoc) => {
    const access = opts.exchange ? await opts.exchange(watchToken) : watchToken;
    const client = (opts.create ?? createSupabaseClient)(cfg.url, cfg.publishableKey, async () => access);
    // Join only after Realtime has the watch token (setAuth is async in realtime-js 2.117).
    await client.realtime.setAuth(access);
    const read = async () => {
      const { data, error } = await client.from("pairing_codes").select("*").eq("code_id", codeId).maybeSingle();
      if (!error && data) onDoc(pairingRowToDoc(data as Record<string, unknown>));
    };
    const ch = client
      .channel(pairingTopic(codeId), { config: { private: true } })
      .on("broadcast", { event: "*" }, () => void read())
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void read();
      });
    return async () => {
      await client.removeChannel(ch).catch(() => undefined);
      await client.removeAllChannels().catch(() => undefined);
    };
  },
});
