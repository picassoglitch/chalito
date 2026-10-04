import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import type { DeviceDoc } from "@chalito/protocol";
import { MemoryAudit, type Deps } from "../src/deps.js";
import { MemoryMcpStore } from "../src/oauth/memory-store.js";
import type { McpStore } from "../src/oauth/model.js";
import type { ApiRepo, StoredWebAuthnCredential, WebAuthnChallenge } from "../src/repo.js";
import { oauthRoutes, type OAuthConfig } from "../src/routes/oauth.js";
import { webauthnRoutes } from "../src/routes/webauthn.js";
import { device, owner } from "./contract/fixtures.js";

/**
 * The OAuth authorization server with in-memory fakes: a phone with a software passkey that can
 * approve consent, CIMD documents for Claude and ChatGPT, and a helper that runs the whole
 * authorization-code + PKCE flow. Shared with the MCP gateway's tests.
 */
export const RP = "chalito.chalyb.com";
export const ORIGIN = `https://${RP}`;
export const ISSUER = "https://api.chalito.test";
export const RESOURCE = "https://mcp.chalito.test/mcp";
export const GATEWAY_TOKEN = "gateway-service-token";
export const CLAUDE_CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const CHATGPT_CLIENT = "https://chatgpt.com/oauth/client.json";
export const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

export const cimdDocs: Record<string, Record<string, unknown>> = {
  [CLAUDE_CLIENT]: {
    client_id: CLAUDE_CLIENT,
    client_name: "Claude",
    redirect_uris: [CLAUDE_REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  },
  [CHATGPT_CLIENT]: {
    client_id: CHATGPT_CLIENT,
    client_name: "ChatGPT",
    redirect_uris: [CHATGPT_REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  },
};

export const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export const oauthHarness = async <S extends McpStore = MemoryMcpStore>(opts: { now?: () => number; mcp?: S } = {}) => {
  const o = owner();
  const phone: DeviceDoc = await device(o, "client");
  const challenges = new Map<string, WebAuthnChallenge>();
  const creds = new Map<string, StoredWebAuthnCredential>();
  const key = (a: string, d: string, p: string) => `${a}/${d}/${p}`;
  const repo: Partial<ApiRepo> = {
    getDevice: async (a, id) => (a === o && id === phone.deviceId ? phone : null),
    putWebAuthnChallenge: async (c) => void challenges.set(key(c.owner, c.deviceId, c.purpose), c),
    takeWebAuthnChallenge: async (a, d, p, now) => {
      const c = challenges.get(key(a, d, p));
      challenges.delete(key(a, d, p));
      return c && c.expiresAt > now ? c.challenge : null;
    },
    setDeviceWebAuthn: async (a, d, cred) => {
      creds.set(`${a}/${d}`, cred);
      return true;
    },
    getDeviceWebAuthn: async (a, d) => creds.get(`${a}/${d}`) ?? null,
  };
  let clock = 1_790_000_000_000;
  const audit = new MemoryAudit();
  const mcp = (opts.mcp ?? new MemoryMcpStore()) as S;
  const deps: Deps & { mcp: S } = {
    repo: repo as ApiRepo,
    identity: {
      verify: async (t: string) => {
        if (t !== "phone-token") throw new Error("bad token");
        return { uid: `d_${phone.deviceId}`, role: "client", owner: o, deviceId: phone.deviceId };
      },
    } as unknown as Deps["identity"],
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: opts.now ?? (() => clock),
    mcp,
  };
  const cfg: OAuthConfig = {
    issuer: ISSUER,
    resource: RESOURCE,
    webOrigin: ORIGIN,
    gatewayToken: GATEWAY_TOKEN,
    accessTtlMs: 15 * 60 * 1000,
    refreshTtlMs: 30 * 24 * 60 * 60 * 1000,
    codeTtlMs: 60 * 1000,
    requestTtlMs: 10 * 60 * 1000,
    cimdTtlMs: 60 * 60 * 1000,
  };
  const cimdFetches: string[] = [];
  const fetchCimd = (async (url: URL | string) => {
    const u = url.toString();
    cimdFetches.push(u);
    const doc = cimdDocs[u];
    return doc ? new Response(JSON.stringify(doc)) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  const wa = { rpId: RP, rpName: "Chalito", origins: [ORIGIN], challengeTtlMs: 60_000 };
  const app = new Hono()
    .route("/v1/webauthn", webauthnRoutes(deps, wa))
    .route("/", oauthRoutes(deps, cfg, { fetchCimd, webauthn: wa }));

  const call = async (
    path: string,
    init: { method?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { ...init.headers };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    const res = await app.request(path, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
    const text = await res.text();
    let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, location: res.headers.get("location") };
  };
  const phoneAuth = { authorization: "Bearer phone-token" };

  // The phone's passkey (registered once).
  const passkey = new SoftAuthenticator({ origin: ORIGIN });
  const regOpts = await call("/v1/webauthn/register/options", { json: {}, headers: phoneAuth });
  await call("/v1/webauthn/register/verify", {
    json: { response: await passkey.create(regOpts.json.options) },
    headers: phoneAuth,
  });
  const assertion = async () => {
    const a = await call("/v1/webauthn/assert/options", { json: {}, headers: phoneAuth });
    return passkey.get(a.json.options);
  };

  /** /oauth/authorize → consent approved on the phone → the code in the redirect. */
  const authorize = async (o2: {
    clientId?: string;
    redirectUri?: string;
    scopes?: string[];
    grant?: string[];
    resource?: string;
    challenge?: string;
  }) => {
    const clientId = o2.clientId ?? CLAUDE_CLIENT;
    const redirectUri = o2.redirectUri ?? (clientId === CHATGPT_CLIENT ? CHATGPT_REDIRECT : CLAUDE_REDIRECT);
    const p = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: o2.challenge ?? p.challenge,
      code_challenge_method: "S256",
      resource: o2.resource ?? RESOURCE,
      scope: (o2.scopes ?? ["mcp:read"]).join(" "),
      state: "st-1",
    });
    const az = await call(`/oauth/authorize?${q}`);
    if (az.status !== 302 || !az.location?.startsWith(`${ORIGIN}/oauth/consent`))
      return {
        az,
        ...p,
        clientId,
        redirectUri,
        code: null as string | null,
        ok: undefined,
        redirect: null,
        requestId: undefined,
      };
    const requestId = new URL(az.location).searchParams.get("request")!;
    const ok = await call(`/oauth/requests/${requestId}/approve`, {
      json: { scopes: o2.grant ?? o2.scopes ?? ["mcp:read"], assertion: await assertion() },
      headers: phoneAuth,
    });
    const redirect = ok.json.redirect ? new URL(ok.json.redirect as string) : null;
    return {
      az,
      requestId,
      ok,
      redirect,
      code: redirect?.searchParams.get("code") ?? null,
      ...p,
      clientId,
      redirectUri,
    };
  };

  const exchange = (
    a: { code: string | null; verifier: string; clientId: string; redirectUri: string },
    resource = RESOURCE,
  ) =>
    call("/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code: a.code ?? "",
        code_verifier: a.verifier,
        client_id: a.clientId,
        redirect_uri: a.redirectUri,
        resource,
      },
    });

  /** A full flow, returning the token response. */
  const connect = async (scopes: string[] = ["mcp:read"], clientId = CLAUDE_CLIENT) => {
    const a = await authorize({ scopes, clientId });
    const t = await exchange(a);
    if (t.status !== 200) throw new Error(`token: ${t.status} ${JSON.stringify(t.json)}`);
    return t.json as { access_token: string; refresh_token: string; scope: string; expires_in: number };
  };

  return {
    o,
    phone,
    deps,
    mcp,
    audit,
    app,
    call,
    phoneAuth,
    assertion,
    authorize,
    exchange,
    connect,
    cimdFetches,
    tick: (ms: number) => (clock += ms),
  };
};
