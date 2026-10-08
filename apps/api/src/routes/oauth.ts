import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { fromB64url, randomNonce } from "@chalito/crypto";
import { CommandBody, RelayedCommand, SealedEnvelope } from "@chalito/protocol";
import { MemoryBuckets } from "@chalito/guard";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { bearerOk } from "../lib/bearer.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { ClientError, fetchCimd, providerOf, redirectAllowed, redirectMatches, registerDcr } from "../oauth/clients.js";
import {
  MCP_SCOPES,
  isMcpScope,
  type McpScope,
  type McpStore,
  type OAuthClient,
  type TokenWithGrant,
} from "../oauth/model.js";
import { newSecret, pkceS256Ok, sameResource, sha256hex } from "../oauth/tokens.js";
import { webauthnConfigFromEnv, type WebAuthnConfig } from "./webauthn.js";

/**
 * Chalito's OAuth 2.1 authorization server for the MCP gateway (ADR 0009, D-017; MCP 2026-07-28):
 * RFC 8414 metadata, CIMD (preferred) and DCR client identification, PKCE S256, RFC 8707 resource
 * pinned to the gateway, RFC 9207 `iss` on the authorization response, 15-minute access tokens,
 * rotating refresh tokens (reuse revokes the grant), and grants revocable at once (the gateway
 * checks every call against the database).
 *
 * Consent happens in the web app: /oauth/authorize parks the request and sends the browser to
 * `${web}/oauth/consent?request=<id>`; a signed-in Chalito client approves it with the device's
 * passkey. session:prompt is a separate, explicit grant, never on by default.
 *
 * The gateway's writes (/v1/gateway/*) come here with the gateway's service token AND the user's
 * access token; this module re-checks the grant and its scopes before writing anything.
 */
export interface OAuthConfig {
  /** This authorization server's issuer (the api's public origin). */
  issuer: string;
  /** The MCP gateway's resource URL (tokens are only ever issued for it). */
  resource: string;
  /** Web app origin that renders the consent page. */
  webOrigin: string;
  /** Service token the gateway presents on /v1/gateway/*. */
  gatewayToken: string;
  accessTtlMs: number;
  refreshTtlMs: number;
  codeTtlMs: number;
  requestTtlMs: number;
  /** CIMD documents are re-fetched after this long. */
  cimdTtlMs: number;
}

export const oauthConfigFromEnv = (env: Record<string, string | undefined> = process.env): OAuthConfig => ({
  issuer: env.CHALITO_API_ISSUER ?? "https://api.chalito.chalyb.com",
  resource: env.CHALITO_MCP_RESOURCE ?? "https://mcp.chalito.chalyb.com/mcp",
  webOrigin: env.CHALITO_WEB_ORIGIN ?? "https://chalito.chalyb.com",
  gatewayToken: env.CHALITO_GATEWAY_TOKEN ?? "",
  accessTtlMs: 15 * 60 * 1000,
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000,
  codeTtlMs: 60 * 1000,
  requestTtlMs: 10 * 60 * 1000,
  cimdTtlMs: 60 * 60 * 1000,
});

/** What the consent screen shows for each scope (ES/EN). session:prompt is never pre-checked. */
export const SCOPE_TEXT: Record<McpScope, { es: string; en: string; defaultChecked: boolean }> = {
  "mcp:read": {
    es: "Ver tus aprobaciones pendientes y el estado de tus sesiones (solo metadatos, salvo las tarjetas que compartas).",
    en: "See your pending approvals and session status (metadata only, except cards you choose to share).",
    defaultChecked: true,
  },
  "mesa:post": {
    es: "Publicar mensajes en tu Mesa (cifrados para tus dispositivos).",
    en: "Post messages to your Mesa (encrypted to your devices).",
    defaultChecked: true,
  },
  "approval:recommend": {
    es: "Sugerir aprobar o rechazar (solo una sugerencia: las decisiones las firmas tú en tu teléfono).",
    en: "Suggest approving or denying (advice only: you sign every decision on your phone).",
    defaultChecked: true,
  },
  "session:prompt": {
    es: "Enviar instrucciones a tus sesiones de agentes. Cada acción que lo requiera seguirá pidiendo tu aprobación firmada.",
    en: "Send prompts to your agent sessions. Any action that needs it still asks for your signed approval.",
    defaultChecked: false,
  },
};

type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "invalid_token"
  | "insufficient_scope";

const oauthError = (c: Context, error: OAuthErrorCode, description: string, status: 400 | 401 | 403 | 429 = 400) =>
  c.json({ error, error_description: description }, status, { "cache-control": "no-store" });

const parseScopes = (raw: string | undefined): McpScope[] | null => {
  const parts = (raw ?? "mcp:read").split(/\s+/).filter(Boolean);
  if (!parts.every(isMcpScope)) return null;
  return [...new Set(parts)] as McpScope[];
};

/** prompt_session per grant: a burst of 10, then 30 an hour. */
const PROMPT_BURST = 10;
const PROMPT_REFILL = 30 / 3600;

const ORIGIN_OF = { claude: "mcp:claude", chatgpt: "mcp:chatgpt" } as const;

export const oauthRoutes = (
  deps: Deps & { mcp?: McpStore },
  cfg: OAuthConfig = oauthConfigFromEnv(),
  opts: { fetchCimd?: typeof fetch; webauthn?: WebAuthnConfig } = {},
) => {
  const app = new Hono<AuthEnv>();
  const promptBuckets = deps.rateBuckets ?? new MemoryBuckets();
  const wa = opts.webauthn ?? webauthnConfigFromEnv();
  const store = (): McpStore => deps.mcp ?? fail(503, "mcp_unavailable");
  const limiter = rateLimit({ capacity: 30, refillPerSec: 1, now: deps.now });

  // ---------------------------------------------------------------- discovery (RFC 8414)
  const metadata = () => ({
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
    token_endpoint: `${cfg.issuer}/oauth/token`,
    registration_endpoint: `${cfg.issuer}/oauth/register`,
    revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
    scopes_supported: [...MCP_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(metadata()));
  app.get("/.well-known/openid-configuration", (c) => c.json(metadata()));

  // ---------------------------------------------------------------- clients
  const resolveClient = async (clientId: string): Promise<OAuthClient> => {
    const known = await store().getClient(clientId);
    if (known?.kind === "dcr") return known;
    if (known?.kind === "cimd" && known.fetchedAt !== null && deps.now() - known.fetchedAt < cfg.cimdTtlMs)
      return known;
    if (!/^https:\/\//.test(clientId)) throw new ClientError("unknown client");
    const fetched = await fetchCimd(clientId, opts.fetchCimd);
    fetched.fetchedAt = deps.now();
    await store().putClient(fetched);
    return fetched;
  };

  /** RFC 7591 registration, kept for clients without CIMD (deprecated in MCP 2026-07-28). */
  app.post("/oauth/register", limiter, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return oauthError(c, "invalid_request", "JSON body required");
    let client: OAuthClient;
    try {
      client = registerDcr(body, `dcr_${newSecret(18)}`);
    } catch (err) {
      return c.json({ error: "invalid_client_metadata", error_description: (err as Error).message }, 400);
    }
    await store().putClient(client);
    return c.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(deps.now() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  // ---------------------------------------------------------------- authorize
  app.get("/oauth/authorize", limiter, async (c) => {
    const q = c.req.query();
    if (!q.client_id || !q.redirect_uri)
      return oauthError(c, "invalid_request", "client_id and redirect_uri are required");
    let client: OAuthClient;
    try {
      client = await resolveClient(q.client_id);
    } catch (err) {
      return oauthError(c, "invalid_client", (err as Error).message);
    }
    if (!redirectAllowed(q.redirect_uri) || !redirectMatches(client.redirectUris, q.redirect_uri))
      return oauthError(c, "invalid_request", "redirect_uri is not registered for this client");
    // From here on, errors go back to the client's redirect_uri.
    const back = (error: string, description: string) => {
      const u = new URL(q.redirect_uri!);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      u.searchParams.set("iss", cfg.issuer);
      return c.redirect(u.toString(), 302);
    };
    if (q.response_type !== "code") return back("unsupported_response_type", "response_type must be code");
    if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge ?? ""))
      return back("invalid_request", "PKCE S256 is required");
    if (!q.resource || !sameResource(q.resource, cfg.resource))
      return back("invalid_target", "resource must be the Chalito MCP gateway");
    const scopes = parseScopes(q.scope);
    if (!scopes) return back("invalid_scope", `scopes are ${MCP_SCOPES.join(" ")}`);
    if (scopes.includes("session:prompt") && providerOf(client) === "other")
      return back("invalid_scope", "session:prompt is only for Claude and ChatGPT connectors");
    const requestId = newSecret(18);
    await store().putRequest({
      requestId,
      clientId: client.clientId,
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge!,
      scopes,
      state: q.state ?? null,
      resource: cfg.resource,
      expiresAt: deps.now() + cfg.requestTtlMs,
    });
    return c.redirect(`${cfg.webOrigin}/oauth/consent?request=${encodeURIComponent(requestId)}`, 302);
  });

  /** What the consent page shows (the signed-in person's web session or client device). */
  app.get("/oauth/requests/:id", requireAuth(deps, ["user", "client"]), async (c) => {
    const r = await store().getRequest(c.req.param("id"), deps.now());
    if (!r) return fail(404, "not_found");
    const client = await store().getClient(r.clientId);
    return c.json({
      requestId: r.requestId,
      client: {
        name: client?.clientName ?? r.clientId,
        id: r.clientId,
        redirectHost: new URL(r.redirectUri).host,
        provider: client ? providerOf(client) : "other",
      },
      scopes: r.scopes.map((s) => ({ scope: s, ...SCOPE_TEXT[s] })),
      expiresAt: r.expiresAt,
    });
  });

  const ApproveBody = z.object({
    /** The scopes the person ticked; a subset of what the client asked for. */
    scopes: z.array(z.string()).min(1),
    /** A passkey assertion over the server's `assert` challenge (/v1/webauthn/assert/options). */
    assertion: z.record(z.string(), z.unknown()),
  });

  /** Approve on a Chalito client device, proven with its passkey. Returns where to send the browser. */
  app.post("/oauth/requests/:id/approve", requireAuth(deps, ["client"]), limiter, async (c) => {
    const p = principal(c);
    const body = ApproveBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const r = await store().getRequest(c.req.param("id"), deps.now());
    if (!r) return fail(404, "not_found");
    const granted = body.data.scopes.filter(isMcpScope);
    if (granted.length !== body.data.scopes.length || !granted.every((s) => r.scopes.includes(s)))
      return fail(400, "scope_not_requested");

    // Passkey: the person is present and verified on a device of their own.
    const cred = await deps.repo.getDeviceWebAuthn(p.owner, p.deviceId!);
    if (!cred) return fail(409, "no_passkey");
    const challenge = await deps.repo.takeWebAuthnChallenge(p.owner, p.deviceId!, "assert", deps.now());
    if (!challenge) return fail(400, "challenge_expired");
    const counter = await verifyAuthenticationResponse({
      response: body.data.assertion as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: wa.origins,
      expectedRPID: wa.rpId,
      credential: {
        id: cred.credentialId,
        publicKey: (await fromB64url(cred.publicKey)) as Uint8Array<ArrayBuffer>,
        // The sign-counter check is the repo's atomic compare below (as in endorse), which also
        // catches concurrent assertions and raises the clone alert (review R-L10).
        counter: 0,
      },
      requireUserVerification: true,
    }).then(
      (v) =>
        v.verified && v.authenticationInfo.credentialID === cred.credentialId ? v.authenticationInfo.newCounter : null,
      () => null,
    );
    if (counter === null) return fail(401, "passkey_failed");
    const bumped = await deps.repo.bumpWebAuthnCounter(p.owner, p.deviceId!, cred.credentialId, counter);
    if (bumped === "not_found") return fail(401, "passkey_failed");
    if (bumped === "cloned") {
      await deps.audit.record({
        action: "webauthn.clone_suspected",
        owner: p.owner,
        actor: p.uid,
        target: p.deviceId!,
        meta: { credentialId: cred.credentialId, stored: cred.counter, reported: counter, during: "oauth.consent" },
      });
      return fail(403, "authenticator_cloned");
    }

    const client = await store().getClient(r.clientId);
    if (!client) return fail(404, "client_gone");
    // Single use: of two concurrent approvals (or an approval racing a denial), only one proceeds,
    // so a request never yields two grants and two codes.
    if (!(await store().deleteRequest(r.requestId))) return fail(404, "not_found");
    const cid = `con_${newSecret(12)}`;
    await store().createGrant({
      owner: p.owner,
      cid,
      clientId: client.clientId,
      clientName: client.clientName,
      provider: providerOf(client),
      scopes: [...new Set(granted)] as McpScope[],
      resource: r.resource,
      createdAt: deps.now(),
      lastUsedAt: null,
      revokedAt: null,
    });
    // Prefixed so redaction recognizes Chalito's own secrets in any log or text (R-M9).
    const code = `chalito_ac_${newSecret(32)}`;
    await store().putCode({
      codeHash: sha256hex(code),
      owner: p.owner,
      cid,
      clientId: client.clientId,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      resource: r.resource,
      scopes: [...new Set(granted)] as McpScope[],
      expiresAt: deps.now() + cfg.codeTtlMs,
    });
    await deps.audit.record({
      action: "mcp.grant_created",
      owner: p.owner,
      actor: p.uid,
      target: cid,
      meta: { client: client.clientId, provider: providerOf(client), scopes: granted },
    });
    const u = new URL(r.redirectUri);
    u.searchParams.set("code", code);
    if (r.state) u.searchParams.set("state", r.state);
    u.searchParams.set("iss", cfg.issuer);
    return c.json({ redirect: u.toString() });
  });

  app.post("/oauth/requests/:id/deny", requireAuth(deps, ["user", "client"]), async (c) => {
    const r = await store().getRequest(c.req.param("id"), deps.now());
    if (!r) return fail(404, "not_found");
    if (!(await store().deleteRequest(r.requestId))) return fail(404, "not_found");
    const u = new URL(r.redirectUri);
    u.searchParams.set("error", "access_denied");
    if (r.state) u.searchParams.set("state", r.state);
    u.searchParams.set("iss", cfg.issuer);
    return c.json({ redirect: u.toString() });
  });

  // ---------------------------------------------------------------- token
  const issue = async (g: { owner: string; cid: string; clientId: string; scopes: McpScope[] }) => {
    const access = `chalito_at_${newSecret(32)}`;
    const refresh = `chalito_rt_${newSecret(32)}`;
    const now = deps.now();
    const base = {
      owner: g.owner,
      cid: g.cid,
      clientId: g.clientId,
      scopes: g.scopes,
      resource: cfg.resource,
      usedAt: null,
    };
    await store().putToken({ ...base, tokenHash: sha256hex(access), kind: "access", expiresAt: now + cfg.accessTtlMs });
    await store().putToken({
      ...base,
      tokenHash: sha256hex(refresh),
      kind: "refresh",
      expiresAt: now + cfg.refreshTtlMs,
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(cfg.accessTtlMs / 1000),
      refresh_token: refresh,
      scope: g.scopes.join(" "),
    };
  };

  app.post("/oauth/token", limiter, async (c) => {
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>;
    const grantType = form.grant_type;
    if (form.resource !== undefined && !sameResource(form.resource, cfg.resource))
      return oauthError(c, "invalid_target", "tokens are only issued for the Chalito MCP gateway");
    if (!form.client_id) return oauthError(c, "invalid_client", "client_id is required");

    if (grantType === "authorization_code") {
      if (!form.code || !form.code_verifier || !form.redirect_uri)
        return oauthError(c, "invalid_request", "code, code_verifier and redirect_uri are required");
      if (!form.resource) return oauthError(c, "invalid_target", "resource is required");
      const code = await store().takeCode(sha256hex(form.code), deps.now());
      if (!code) return oauthError(c, "invalid_grant", "unknown, used or expired code");
      if (code.clientId !== form.client_id || code.redirectUri !== form.redirect_uri)
        return oauthError(c, "invalid_grant", "client or redirect_uri mismatch");
      if (!pkceS256Ok(form.code_verifier, code.codeChallenge)) {
        // A failed verifier burns the grant: the code may have been intercepted.
        await store().revokeGrant(code.owner, code.cid, deps.now());
        return oauthError(c, "invalid_grant", "PKCE verification failed");
      }
      return c.json(await issue(code), 200, { "cache-control": "no-store" });
    }

    if (grantType === "refresh_token") {
      if (!form.refresh_token) return oauthError(c, "invalid_request", "refresh_token is required");
      const h = sha256hex(form.refresh_token);
      const t = await store().getToken(h);
      if (
        !t ||
        t.kind !== "refresh" ||
        t.clientId !== form.client_id ||
        t.expiresAt <= deps.now() ||
        t.grantRevokedAt !== null
      )
        return oauthError(c, "invalid_grant", "unknown, expired or revoked refresh token");
      const used = await store().useRefresh(h, deps.now());
      if (used !== "ok") {
        // Reuse of a rotated refresh token: assume theft and revoke the whole grant.
        await store().revokeGrant(t.owner, t.cid, deps.now());
        await deps.audit.record({ action: "mcp.refresh_reuse", owner: t.owner, actor: t.clientId, target: t.cid });
        return oauthError(c, "invalid_grant", "refresh token reuse; the grant was revoked");
      }
      const scopes = form.scope ? parseScopes(form.scope) : t.scopes;
      if (!scopes || !scopes.every((s) => t.scopes.includes(s)))
        return oauthError(c, "invalid_scope", "scope exceeds the grant");
      return c.json(await issue({ owner: t.owner, cid: t.cid, clientId: t.clientId, scopes }), 200, {
        "cache-control": "no-store",
      });
    }

    return oauthError(c, "unsupported_grant_type", "authorization_code or refresh_token");
  });

  /** RFC 7009: revoking either token revokes the grant (and every token of it). */
  app.post("/oauth/revoke", limiter, async (c) => {
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>;
    if (form.token) {
      const t = await store().getToken(sha256hex(form.token));
      if (t) {
        await store().revokeGrant(t.owner, t.cid, deps.now());
        await deps.audit.record({
          action: "mcp.grant_revoked",
          owner: t.owner,
          actor: t.clientId,
          target: t.cid,
          meta: { via: "client" },
        });
      }
    }
    return c.body(null, 200);
  });

  // ---------------------------------------------------------------- the person's grants
  app.get("/v1/connectors", requireAuth(deps, ["user", "client"]), async (c) => {
    const grants = await store().listGrants(principal(c).owner);
    return c.json({ connectors: grants.map((g) => ({ ...g, owner: undefined })) });
  });

  app.post("/v1/connectors/:cid/revoke", requireAuth(deps, ["user", "client"]), async (c) => {
    const p = principal(c);
    if (!(await store().revokeGrant(p.owner, c.req.param("cid"), deps.now()))) return fail(404, "not_found");
    await deps.audit.record({
      action: "mcp.grant_revoked",
      owner: p.owner,
      actor: p.uid,
      target: c.req.param("cid"),
      meta: { via: "user" },
    });
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- card sharing (opt-in)
  const SharingBody = z
    .object({
      sessionId: z.string().min(1).max(128).optional(),
      deviceId: z.string().min(1).max(128).optional(),
      enabled: z.boolean(),
      /** Turning it on requires acknowledging that the card is stored in plaintext for MCP. */
      plaintextAck: z.boolean().optional(),
    })
    .refine((b) => !!b.sessionId !== !!b.deviceId, { message: "exactly one of sessionId or deviceId" });

  app.post("/v1/mcp/sharing", requireAuth(deps, ["client"]), async (c) => {
    const p = principal(c);
    const b = SharingBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return fail(400, "bad_request");
    if (b.data.enabled && b.data.plaintextAck !== true) return fail(400, "plaintext_ack_required");
    const scope = b.data.sessionId ? "session" : "device";
    const target = (b.data.sessionId ?? b.data.deviceId)!;
    await store().setSharing(p.owner, scope, target, b.data.enabled, b.data.enabled ? deps.now() : null);
    await deps.audit.record({
      action: b.data.enabled ? "mcp.sharing_on" : "mcp.sharing_off",
      owner: p.owner,
      actor: p.uid,
      target,
      meta: { scope },
    });
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- gateway writes
  /** The gateway's service token AND a live user access token with the needed scope. */
  const gatewayCall = async (c: Context, scope: McpScope): Promise<TokenWithGrant | Response> => {
    if (!bearerOk(c.req.header("authorization"), cfg.gatewayToken))
      return oauthError(c, "invalid_client", "gateway only", 401);
    const tok = c.req.header("x-chalito-access-token") ?? "";
    const t = tok ? await store().getToken(sha256hex(tok)) : null;
    if (
      !t ||
      t.kind !== "access" ||
      t.expiresAt <= deps.now() ||
      t.grantRevokedAt !== null ||
      !sameResource(t.resource, cfg.resource)
    )
      return oauthError(c, "invalid_token", "unknown, expired or revoked access token", 401);
    if (!t.scopes.includes(scope)) return oauthError(c, "insufficient_scope", `requires ${scope}`, 403);
    await store().touchGrant(t.owner, t.cid, deps.now());
    return t;
  };

  app.post("/v1/gateway/recommendations", async (c) => {
    const t = await gatewayCall(c, "approval:recommend");
    if (t instanceof Response) return t;
    const b = z
      .object({ aid: z.string().min(1).max(128), allow: z.boolean(), note: z.string().max(500).default("") })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return fail(400, "bad_request");
    const res = await store().recommend(t.owner, b.data.aid, {
      from: `mcp:${t.provider}`,
      allow: b.data.allow,
      note: b.data.note,
      at: deps.now(),
    });
    if (res === "not_found") return fail(404, "not_found");
    if (res === "full") return fail(409, "too_many_recommendations");
    await deps.audit.record({
      action: "mcp.recommend",
      owner: t.owner,
      actor: `mcp:${t.provider}`,
      target: b.data.aid,
      meta: { cid: t.cid },
    });
    return c.body(null, 204);
  });

  app.post("/v1/gateway/mesa-turns", async (c) => {
    const t = await gatewayCall(c, "mesa:post");
    if (t instanceof Response) return t;
    const b = z
      .object({
        mid: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .default("mcp_inbox"),
        ct: SealedEnvelope,
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return fail(400, "bad_request");
    const tid = `t_${randomUUID().replace(/-/g, "")}`;
    await store().insertMesaTurn(t.owner, b.data.mid, tid, {
      origin: `mcp:${t.provider}`,
      ct: b.data.ct,
      t: deps.now(),
      cid: t.cid,
    });
    await deps.audit.record({
      action: "mcp.mesa_post",
      owner: t.owner,
      actor: `mcp:${t.provider}`,
      target: b.data.mid,
      meta: { cid: t.cid },
    });
    return c.json({ tid }, 201);
  });

  /**
   * prompt_session: a RelayedCommand (can only prompt; origin mcp:<provider>) for the agent that
   * runs the session, with the prompt sealed by the gateway to that agent's key. The agent applies
   * its local policy to the origin; any approval it raises needs a signed phone decision.
   */
  app.post("/v1/gateway/prompts", async (c) => {
    const t = await gatewayCall(c, "session:prompt");
    if (t instanceof Response) return t;
    if (t.provider === "other")
      return oauthError(c, "insufficient_scope", "session:prompt needs a Claude or ChatGPT connector", 403);
    // Per-grant cap (review R-M13): a prompt-injected conversation can't flood sessions.
    // Shared across instances when the api has the Postgres buckets.
    if (
      !(await promptBuckets.take(sha256hex(`mcp.prompt:${t.owner}:${t.cid}`), PROMPT_BURST, PROMPT_REFILL, deps.now()))
    )
      return oauthError(c, "invalid_request", "too many prompts for this connector; try again later", 429);
    const b = z
      .object({
        cid: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
        sid: z.string().min(1).max(128),
        promptCt: SealedEnvelope,
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return fail(400, "bad_request");
    const device = await store().sessionDevice(t.owner, b.data.sid);
    if (!device) return fail(404, "no_session");
    const now = deps.now();
    const body = CommandBody.safeParse({
      v: 1,
      cid: b.data.cid,
      uid: t.owner,
      targetDeviceId: device,
      origin: ORIGIN_OF[t.provider],
      nonce: await randomNonce(),
      issuedAt: now,
      expiresAt: now + 5 * 60 * 1000,
      payload: { type: "session.prompt", sid: b.data.sid, promptCt: b.data.promptCt },
    });
    if (!body.success) return fail(400, "bad_request");
    const env = RelayedCommand.parse({ relayedBy: "mcp-gateway", body: body.data });
    const inserted = await store().insertCommand(t.owner, device, b.data.cid, env, body.data.expiresAt);
    if (inserted === "no_device") return fail(404, "no_device");
    // A reused command id (a gateway retry) was a primary-key violation, i.e. a 500, before.
    if (inserted === "exists") return fail(409, "duplicate_command");
    await deps.audit.record({
      action: "mcp.prompt",
      owner: t.owner,
      actor: ORIGIN_OF[t.provider],
      target: b.data.sid,
      meta: { cid: t.cid, command: b.data.cid },
    });
    return c.json({ cid: b.data.cid, targetDeviceId: device }, 201);
  });

  /** Read-side calls the gateway serves from its read-only connection, logged here. */
  app.post("/v1/gateway/audit", async (c) => {
    const t = await gatewayCall(c, "mcp:read");
    if (t instanceof Response) return t;
    const b = z
      .object({ tool: z.enum(["list_pending", "get_session_card"]), target: z.string().max(128).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return fail(400, "bad_request");
    await deps.audit.record({
      action: `mcp.${b.data.tool}`,
      owner: t.owner,
      actor: `mcp:${t.provider}`,
      ...(b.data.target ? { target: b.data.target } : {}),
      meta: { cid: t.cid },
    });
    return c.body(null, 204);
  });

  return app;
};
