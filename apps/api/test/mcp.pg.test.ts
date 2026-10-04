/**
 * M10 on Postgres: the OAuth flow on PostgresMcpStore (as chalito_server), and the MCP gateway's
 * reader on its read-only role (chalito_gateway), against DATABASE_URL (`pnpm test:pg`).
 */
import postgres from "postgres";
import { generateBoxKeyPair, sealJson } from "@chalito/crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresMcpStore } from "../src/oauth/postgres-store.js";
import { sha256hex } from "../src/oauth/tokens.js";
import { chalitoSql } from "../src/postgres/repo.js";
import { PostgresGatewayReader, gatewaySql } from "../../mcp-gateway/src/postgres-reader.js";
import { CLAUDE_CLIENT, GATEWAY_TOKEN, RESOURCE, oauthHarness } from "./oauth-harness.js";

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("M10 OAuth + gateway reader on Postgres", () => {
  const admin = postgres(DB_URL ?? "postgres://unused", { max: 2, onnotice: () => {} });
  const server = chalitoSql(DB_URL ?? "postgres://unused", {
    max: 2,
    role: process.env.CHALITO_DB_ROLE ?? "chalito_server",
  });
  const gw = gatewaySql(DB_URL ?? "postgres://unused", { max: 2, role: "chalito_gateway" });
  const reader = new PostgresGatewayReader(gw);
  afterAll(async () => {
    await Promise.all([admin.end(), server.end(), gw.end()]);
  });

  const setup = async () => {
    const h = await oauthHarness({ mcp: new PostgresMcpStore(server), now: Date.now });
    const agent = `agt_${h.o.slice(-12)}`;
    await admin.begin(async (tx) => {
      await tx`insert into chalito.tenants (id) values (${h.o})`;
      await tx`insert into chalito.users (id, tenant_id) values (${h.o}, ${h.o})`;
      await tx`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
               values (${h.o}, ${h.phone.deviceId}, 'client', 'phone', 'ios', 'Phone', 'p', ${h.phone.pubBox}, 'f', 'first_client'),
                      (${h.o}, ${agent}, 'agent', 'desktop', 'linux', 'Desk', 'p', 'agentbox', 'f', 'pairing')`;
      await tx`insert into chalito.sessions (owner, sid, device_id, doc) values (${h.o}, 's_1', ${agent}, ${tx.json({ state: "running", adapter: "claude-code" })})`;
      await tx`insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
               values (${h.o}, 'apr_1', ${agent}, 's_1', 'req_1', 'tool', 'HIGH', 'local', true, '{}', now() + interval '5 minutes')`;
    });
    return { h, agent };
  };
  const gwHeaders = (access: string) => ({
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    "x-chalito-access-token": access,
  });

  it("CIMD + PKCE → tokens; the gateway role sees a live token, then not after revocation", async () => {
    const { h } = await setup();
    const t = await h.connect(["mcp:read", "approval:recommend"]);
    const live = await reader.accessToken(sha256hex(t.access_token), Date.now());
    expect(live).toMatchObject({ owner: h.o, provider: "claude", clientId: CLAUDE_CLIENT, resource: RESOURCE });
    expect(live!.scopes).toEqual(["mcp:read", "approval:recommend"]);
    expect(await reader.accessToken(sha256hex(t.refresh_token), Date.now())).toBeNull();
    expect((await reader.pending(h.o, Date.now())).map((p) => p.aid)).toEqual(["apr_1"]);

    expect(
      (
        await h.call("/v1/gateway/recommendations", {
          json: { aid: "apr_1", allow: false },
          headers: gwHeaders(t.access_token),
        })
      ).status,
    ).toBe(204);
    expect((await reader.pending(h.o, Date.now()))[0]!.recommendations).toBe(1);

    const [g] = await admin`select cid from chalito.connectors where owner = ${h.o}`;
    expect((await h.call(`/v1/connectors/${g!.cid}/revoke`, { method: "POST", headers: h.phoneAuth })).status).toBe(
      204,
    );
    expect(await reader.accessToken(sha256hex(t.access_token), Date.now())).toBeNull();
  });

  it("refresh rotation and reuse detection", async () => {
    const { h } = await setup();
    const t = await h.connect();
    const refresh = (r: string) =>
      h.call("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: r, client_id: CLAUDE_CLIENT } });
    const r1 = await refresh(t.refresh_token);
    expect(r1.status).toBe(200);
    expect((await refresh(t.refresh_token)).json.error).toBe("invalid_grant");
    const [g] = await admin`select revoked_at from chalito.connectors where owner = ${h.o}`;
    expect(g!.revoked_at).not.toBeNull();
    expect((await admin`select count(*)::int as n from chalito_private.oauth_tokens where owner = ${h.o}`)[0]!.n).toBe(
      0,
    );
  });

  it("prompts are queued as RelayedCommands; mesa posts stored; sharing on/off", async () => {
    const { h, agent } = await setup();
    const t = await h.connect(["mcp:read", "mesa:post", "session:prompt"]);
    expect(await reader.sessionAgent(h.o, "s_1")).toEqual({ deviceId: agent, pubBox: "agentbox" });
    expect(await reader.clientBoxKeys(h.o)).toEqual({ [h.phone.deviceId]: h.phone.pubBox });
    const ct = await sealJson("hola", { [agent]: (await generateBoxKeyPair()).publicKey }, "command:mcp_0123456789ab");
    const p = await h.call("/v1/gateway/prompts", {
      json: { cid: "mcp_0123456789ab", sid: "s_1", promptCt: ct },
      headers: gwHeaders(t.access_token),
    });
    expect(p.status).toBe(201);
    const [cmd] = await admin`select env, from_device_id from chalito.commands where owner = ${h.o}`;
    expect(cmd).toMatchObject({
      from_device_id: "mcp-gateway",
      env: { relayedBy: "mcp-gateway", body: { origin: "mcp:claude" } },
    });
    const m = await h.call("/v1/gateway/mesa-turns", { json: { ct }, headers: gwHeaders(t.access_token) });
    expect(m.status).toBe(201);
    expect((await admin`select doc->>'origin' as o from chalito.mesa_turns where owner = ${h.o}`)[0]!.o).toBe(
      "mcp:claude",
    );

    // Sharing: off → no card; on (+ the agent's plaintext copy) → card; off → deleted.
    expect((await reader.session(h.o, "s_1"))!.state).toBe("running");
    expect(await reader.sharedCard(h.o, "s_1")).toBeNull();
    await h.call("/v1/mcp/sharing", {
      json: { sessionId: "s_1", enabled: true, plaintextAck: true },
      headers: h.phoneAuth,
    });
    await admin`insert into chalito.session_card_plain (owner, sid, device_id, card) values (${h.o}, 's_1', ${agent}, ${admin.json({ goal: "g" })})`;
    expect(await reader.sharedCard(h.o, "s_1")).toEqual({ goal: "g" });
    await h.call("/v1/mcp/sharing", { json: { sessionId: "s_1", enabled: false }, headers: h.phoneAuth });
    expect(await reader.sharedCard(h.o, "s_1")).toBeNull();
    expect((await admin`select count(*)::int as n from chalito.session_card_plain where owner = ${h.o}`)[0]!.n).toBe(0);
  });

  it("the gateway role can't write", async () => {
    await expect(gw`update chalito.approvals set status = 'approved'`).rejects.toThrow(/permission denied/);
    await expect(gw`delete from chalito_private.oauth_tokens`).rejects.toThrow(/permission denied/);
  });
});
