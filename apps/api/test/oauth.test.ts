import { describe, expect, it } from "vitest";
import { generateBoxKeyPair, sealJson } from "@chalito/crypto";
import { RelayedCommand } from "@chalito/protocol";
import { pkceS256Ok, sameResource, sha256hex } from "../src/oauth/tokens.js";
import { redirectAllowed, redirectMatches } from "../src/oauth/clients.js";
import { SCOPE_TEXT } from "../src/routes/oauth.js";
import {
  CHATGPT_CLIENT,
  CLAUDE_CLIENT,
  CLAUDE_REDIRECT,
  GATEWAY_TOKEN,
  ISSUER,
  RESOURCE,
  oauthHarness,
  pkce,
} from "./oauth-harness.js";

describe("OAuth metadata (RFC 8414)", () => {
  it("advertises CIMD, public clients and S256 only", async () => {
    const h = await oauthHarness();
    const m = (await h.call("/.well-known/oauth-authorization-server")).json;
    expect(m).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["mcp:read", "mesa:post", "approval:recommend", "session:prompt"],
    });
    expect(JSON.stringify(m)).not.toMatch(/approval:decide|devmode|policy|rooms|billing/);
  });

  it("consent text exists in ES and EN, and session:prompt is never pre-checked", () => {
    for (const t of Object.values(SCOPE_TEXT)) expect(t.es && t.en).toBeTruthy();
    expect(SCOPE_TEXT["session:prompt"].defaultChecked).toBe(false);
  });
});

describe("authorization code + PKCE with a CIMD client", () => {
  it("happy path: authorize → passkey consent → code → tokens pinned to the gateway", async () => {
    const h = await oauthHarness();
    const a = await h.authorize({ scopes: ["mcp:read", "mesa:post"] });
    expect(h.cimdFetches).toEqual([CLAUDE_CLIENT]);
    expect(a.ok?.status).toBe(200);
    expect(a.redirect?.origin + a.redirect!.pathname).toBe(CLAUDE_REDIRECT);
    expect(a.redirect?.searchParams.get("state")).toBe("st-1");
    expect(a.redirect?.searchParams.get("iss")).toBe(ISSUER);
    const t = await h.exchange(a);
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "mcp:read mesa:post" });
    const stored = await h.mcp.getToken(sha256hex(t.json.access_token as string));
    expect(stored).toMatchObject({ kind: "access", resource: RESOURCE, provider: "claude", owner: h.o });
    expect(stored!.expiresAt - h.deps.now()).toBe(15 * 60 * 1000);
    // Only hashes are stored.
    expect([...h.mcp.tokens.keys()].some((k) => k === t.json.access_token)).toBe(false);
    const grants = (await h.call("/v1/connectors", { headers: h.phoneAuth })).json.connectors;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ clientName: "Claude", provider: "claude", scopes: ["mcp:read", "mesa:post"] });
    // The consent page sees the client and per-scope text.
    expect(h.audit.events.some((e) => e.action === "mcp.grant_created")).toBe(true);
  });

  it("the person may grant fewer scopes than asked, never more", async () => {
    const h = await oauthHarness();
    const a = await h.authorize({ scopes: ["mcp:read", "session:prompt"], grant: ["mcp:read"] });
    expect((await h.exchange(a)).json.scope).toBe("mcp:read");
    const b = await h.authorize({ scopes: ["mcp:read"], grant: ["mcp:read", "mesa:post"] });
    expect(b.ok?.json).toEqual({ error: "scope_not_requested" });
  });

  it("the consent screen gets the request details", async () => {
    const h = await oauthHarness();
    const p = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: CHATGPT_CLIENT,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      code_challenge: p.challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:read session:prompt",
    });
    const az = await h.call(`/oauth/authorize?${q}`);
    const id = new URL(az.location!).searchParams.get("request")!;
    const r = await h.call(`/oauth/requests/${id}`, { headers: h.phoneAuth });
    expect(r.json.client).toMatchObject({ name: "ChatGPT", provider: "chatgpt", redirectHost: "chatgpt.com" });
    expect(r.json.scopes.map((s: { scope: string; defaultChecked: boolean }) => [s.scope, s.defaultChecked])).toEqual([
      ["mcp:read", true],
      ["session:prompt", false],
    ]);
    expect((await h.call(`/oauth/requests/${id}`)).status).toBe(401);
  });

  it("wrong verifier: refused, and the grant is burned", async () => {
    const h = await oauthHarness();
    const a = await h.authorize({});
    const t = await h.exchange({ ...a, verifier: pkce().verifier });
    expect(t).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect([...h.mcp.grants.values()][0]!.revokedAt).not.toBeNull();
    // The code is single-use either way.
    expect((await h.exchange(a)).json.error).toBe("invalid_grant");
  });

  it("wrong audience: authorize and token both refuse any resource but the gateway", async () => {
    const h = await oauthHarness();
    const bad = await h.authorize({ resource: "https://evil.example/mcp" });
    expect(bad.az.status).toBe(302);
    const loc = new URL(bad.az.location!);
    expect(loc.origin + loc.pathname).toBe(CLAUDE_REDIRECT);
    expect(loc.searchParams.get("error")).toBe("invalid_target");
    const a = await h.authorize({});
    expect((await h.exchange(a, "https://evil.example/mcp")).json.error).toBe("invalid_target");
    // A token for the gateway is not a token for anything else (the gateway pins the resource).
    const t = await h.connect();
    expect(sameResource((await h.mcp.getToken(sha256hex(t.access_token)))!.resource, RESOURCE)).toBe(true);
  });

  it("a code is bound to its client and redirect_uri, and expires in a minute", async () => {
    const h = await oauthHarness();
    const a = await h.authorize({});
    expect((await h.exchange({ ...a, clientId: CHATGPT_CLIENT })).json.error).toBe("invalid_grant");
    const b = await h.authorize({});
    h.tick(61_000);
    expect((await h.exchange(b)).json.error).toBe("invalid_grant");
  });

  it("refuses unregistered or disallowed redirects without redirecting, plain PKCE, and bad scopes", async () => {
    const h = await oauthHarness();
    const evil = await h.authorize({ redirectUri: "https://evil.example/cb" });
    expect(evil.az).toMatchObject({ status: 400, json: { error: "invalid_request" } });
    const p = pkce();
    const plain = await h.call(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CLAUDE_CLIENT,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: p.verifier,
        code_challenge_method: "plain",
        resource: RESOURCE,
      })}`,
    );
    expect(new URL(plain.location!).searchParams.get("error")).toBe("invalid_request");
    for (const scope of ["approval:decide", "mcp:read devmode", "rooms"]) {
      const r = await h.authorize({ scopes: scope.split(" ") });
      expect(new URL(r.az.location!).searchParams.get("error")).toBe("invalid_scope");
    }
  });

  it("CIMD: the document must name itself and only allow known redirect hosts", async () => {
    const h = await oauthHarness();
    const r = await h.authorize({ clientId: "https://claude.ai/unknown.json" });
    expect(r.az).toMatchObject({ status: 400, json: { error: "invalid_client" } });
    // Cached for an hour.
    await h.authorize({});
    await h.authorize({});
    expect(h.cimdFetches.filter((u) => u === CLAUDE_CLIENT)).toHaveLength(1);
  });

  it("consent needs a fresh passkey assertion", async () => {
    const h = await oauthHarness();
    const p = pkce();
    const az = await h.call(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CLAUDE_CLIENT,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: p.challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      })}`,
    );
    const id = new URL(az.location!).searchParams.get("request")!;
    const assertion = await h.assertion();
    const ok = await h.call(`/oauth/requests/${id}/approve`, {
      json: { scopes: ["mcp:read"], assertion },
      headers: h.phoneAuth,
    });
    expect(ok.status).toBe(200);
    // The same assertion can't approve another request (its challenge is spent).
    const r2 = await h.authorize({});
    expect(r2.ok?.status).toBe(200);
    const again = await h.call(`/oauth/requests/${r2.requestId}/approve`, {
      json: { scopes: ["mcp:read"], assertion },
      headers: h.phoneAuth,
    });
    expect(again.status).toBe(404); // the request was consumed
    const r3 = await h.authorize({ scopes: ["mcp:read"] });
    void r3;
    const p3 = pkce();
    const az3 = await h.call(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CLAUDE_CLIENT,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: p3.challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      })}`,
    );
    const id3 = new URL(az3.location!).searchParams.get("request")!;
    expect(
      (
        await h.call(`/oauth/requests/${id3}/approve`, {
          json: { scopes: ["mcp:read"], assertion },
          headers: h.phoneAuth,
        })
      ).json.error,
    ).toBe("challenge_expired");
  });
});

describe("DCR (kept for clients without CIMD)", () => {
  it("registers a loopback client; it can connect but never gets session:prompt", async () => {
    const h = await oauthHarness();
    const reg = await h.call("/oauth/register", {
      json: { client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:3118/callback"] },
    });
    expect(reg.status).toBe(201);
    const clientId = reg.json.client_id as string;
    expect(clientId).toMatch(/^dcr_/);
    const a = await h.authorize({ clientId, redirectUri: "http://127.0.0.1:49152/callback" });
    expect((await h.exchange(a)).status).toBe(200);
    const p = await h.authorize({ clientId, redirectUri: "http://127.0.0.1:1/callback", scopes: ["session:prompt"] });
    expect(new URL(p.az.location!).searchParams.get("error")).toBe("invalid_scope");
    expect((await h.call("/oauth/register", { json: { redirect_uris: ["https://evil.example/cb"] } })).json.error).toBe(
      "invalid_client_metadata",
    );
  });
});

describe("refresh tokens rotate", () => {
  it("each refresh returns a new pair; reusing an old one revokes the grant", async () => {
    const h = await oauthHarness();
    const t1 = await h.connect(["mcp:read", "mesa:post"]);
    const refresh = (token: string, scope?: string) =>
      h.call("/oauth/token", {
        form: {
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: CLAUDE_CLIENT,
          ...(scope ? { scope } : {}),
        },
      });
    const r1 = await refresh(t1.refresh_token);
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t1.refresh_token);
    expect((await refresh(r1.json.refresh_token as string, "mcp:read session:prompt")).json.error).toBe(
      "invalid_scope",
    );
    const reuse = await refresh(t1.refresh_token);
    expect(reuse.json.error).toBe("invalid_grant");
    expect([...h.mcp.grants.values()][0]!.revokedAt).not.toBeNull();
    expect(h.mcp.tokens.size).toBe(0);
    expect(h.audit.events.some((e) => e.action === "mcp.refresh_reuse")).toBe(true);
  });
});

describe("revocation and the gateway's write routes", () => {
  const gw = (access: string) => ({ authorization: `Bearer ${GATEWAY_TOKEN}`, "x-chalito-access-token": access });

  it("a revoked grant stops working at once", async () => {
    const h = await oauthHarness();
    h.mcp.approvals.set(`${h.o}/apr_1`, { owner: h.o, status: "pending", recommendations: [] });
    const t = await h.connect(["mcp:read", "approval:recommend"]);
    const rec = () =>
      h.call("/v1/gateway/recommendations", {
        json: { aid: "apr_1", allow: true, note: "tests pass" },
        headers: gw(t.access_token),
      });
    expect((await rec()).status).toBe(204);
    expect(h.mcp.approvals.get(`${h.o}/apr_1`)!.recommendations).toEqual([
      { from: "mcp:claude", allow: true, note: "tests pass", at: h.deps.now() },
    ]);
    const cid = [...h.mcp.grants.values()][0]!.cid;
    expect((await h.call(`/v1/connectors/${cid}/revoke`, { method: "POST", headers: h.phoneAuth })).status).toBe(204);
    expect(await rec()).toMatchObject({ status: 401, json: { error: "invalid_token" } });
    const refresh = await h.call("/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLAUDE_CLIENT },
    });
    expect(refresh.json.error).toBe("invalid_grant");
  });

  it("the client can revoke its own token (RFC 7009), which revokes the grant", async () => {
    const h = await oauthHarness();
    const t = await h.connect();
    expect((await h.call("/oauth/revoke", { form: { token: t.refresh_token } })).status).toBe(200);
    expect([...h.mcp.grants.values()][0]!.revokedAt).not.toBeNull();
    expect(
      (await h.call("/v1/gateway/audit", { json: { tool: "list_pending" }, headers: gw(t.access_token) })).status,
    ).toBe(401);
  });

  it("enforces scopes, the service token and expiry", async () => {
    const h = await oauthHarness();
    const t = await h.connect(["mcp:read"]);
    expect(await h.call("/v1/gateway/mesa-turns", { json: { ct: {} }, headers: gw(t.access_token) })).toMatchObject({
      status: 403,
      json: { error: "insufficient_scope" },
    });
    expect((await h.call("/v1/gateway/prompts", { json: {}, headers: gw(t.access_token) })).json.error).toBe(
      "insufficient_scope",
    );
    expect(
      (
        await h.call("/v1/gateway/audit", {
          json: { tool: "list_pending" },
          headers: { authorization: "Bearer wrong", "x-chalito-access-token": t.access_token },
        })
      ).status,
    ).toBe(401);
    expect(
      (await h.call("/v1/gateway/audit", { json: { tool: "list_pending" }, headers: gw(t.access_token) })).status,
    ).toBe(204);
    h.tick(15 * 60 * 1000 + 1);
    expect(
      (await h.call("/v1/gateway/audit", { json: { tool: "list_pending" }, headers: gw(t.access_token) })).status,
    ).toBe(401);
    // A refresh token is not an access token.
    expect(
      (await h.call("/v1/gateway/audit", { json: { tool: "list_pending" }, headers: gw(t.refresh_token) })).status,
    ).toBe(401);
  });

  it("prompts become RelayedCommands for the session's agent, with origin mcp:<provider>", async () => {
    const h = await oauthHarness();
    h.mcp.sessions.set(`${h.o}/s_1`, "dev_agent");
    h.mcp.devices.add(`${h.o}/dev_agent`);
    const t = await h.connect(["mcp:read", "session:prompt"], CHATGPT_CLIENT);
    const box = await generateBoxKeyPair();
    const cid = "cmd_abcdefgh1234";
    const promptCt = await sealJson("run the tests", { dev_agent: box.publicKey }, `command:${cid}`);
    const r = await h.call("/v1/gateway/prompts", {
      json: { cid, sid: "s_1", promptCt },
      headers: gw(t.access_token),
    });
    expect(r).toMatchObject({ status: 201, json: { cid, targetDeviceId: "dev_agent" } });
    const env = RelayedCommand.parse(h.mcp.commands[0]!.env);
    expect(env.relayedBy).toBe("mcp-gateway");
    expect(env.body).toMatchObject({
      origin: "mcp:chatgpt",
      targetDeviceId: "dev_agent",
      payload: { type: "session.prompt", sid: "s_1" },
    });
    expect(
      (
        await h.call("/v1/gateway/prompts", {
          json: { cid, sid: "nope", promptCt },
          headers: gw(t.access_token),
        })
      ).status,
    ).toBe(404);
  });

  it("card sharing needs the plaintext acknowledgement to turn on", async () => {
    const h = await oauthHarness();
    expect(
      (await h.call("/v1/mcp/sharing", { json: { sessionId: "s_1", enabled: true }, headers: h.phoneAuth })).json.error,
    ).toBe("plaintext_ack_required");
    expect(
      (
        await h.call("/v1/mcp/sharing", {
          json: { sessionId: "s_1", enabled: true, plaintextAck: true },
          headers: h.phoneAuth,
        })
      ).status,
    ).toBe(204);
    expect(h.mcp.sharing.get(`${h.o}/session/s_1`)).toEqual({ enabled: true, ackAt: h.deps.now() });
  });
});

describe("helpers", () => {
  it("PKCE S256, resource comparison and redirect rules", () => {
    const p = pkce();
    expect(pkceS256Ok(p.verifier, p.challenge)).toBe(true);
    expect(pkceS256Ok(pkce().verifier, p.challenge)).toBe(false);
    expect(pkceS256Ok("short", p.challenge)).toBe(false);
    expect(sameResource(`${RESOURCE}/`, RESOURCE)).toBe(true);
    expect(sameResource("https://mcp.chalito.test/other", RESOURCE)).toBe(false);
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed("https://claude.ai.evil.example/cb")).toBe(false);
    expect(redirectAllowed("http://example.com/cb")).toBe(false);
    expect(redirectMatches(["http://localhost:1/cb"], "http://localhost:5000/cb")).toBe(true);
    expect(redirectMatches(["https://claude.ai/a"], "https://claude.ai/b")).toBe(false);
  });
});

describe("single use under races (audit 2026-10-08)", () => {
  const gw = (access: string) => ({ authorization: `Bearer ${GATEWAY_TOKEN}`, "x-chalito-access-token": access });

  it("a consent request read by two approvals at once yields one grant: the second is 404", async () => {
    const h = await oauthHarness();
    // Every read returns what the first one saw, as two concurrent approvals would.
    const seen = new Map<string, Awaited<ReturnType<typeof h.mcp.getRequest>>>();
    const real = h.mcp.getRequest.bind(h.mcp);
    h.mcp.getRequest = async (id, now) => {
      if (!seen.has(id)) seen.set(id, await real(id, now));
      return seen.get(id)!;
    };
    const a = await h.authorize({ scopes: ["mcp:read"] });
    expect(a.ok?.status).toBe(200);
    const again = await h.call(`/oauth/requests/${a.requestId}/approve`, {
      json: { scopes: ["mcp:read"], assertion: await h.assertion() },
      headers: h.phoneAuth,
    });
    expect(again.status).toBe(404);
    expect(h.mcp.grants.size).toBe(1);
  });

  it("a gateway retry with the same command id is 409, not a 500", async () => {
    const h = await oauthHarness();
    h.mcp.sessions.set(`${h.o}/s_1`, "dev_agent");
    h.mcp.devices.add(`${h.o}/dev_agent`);
    const t = await h.connect(["mcp:read", "session:prompt"], CHATGPT_CLIENT);
    const box = await generateBoxKeyPair();
    const cid = "cmd_dupdupdup1234";
    const promptCt = await sealJson("hi", { dev_agent: box.publicKey }, `command:${cid}`);
    const send = () =>
      h.call("/v1/gateway/prompts", { json: { cid, sid: "s_1", promptCt }, headers: gw(t.access_token) });
    expect((await send()).status).toBe(201);
    expect(await send()).toMatchObject({ status: 409, json: { error: "duplicate_command" } });
    expect(h.mcp.commands).toHaveLength(1);
  });
});
